import {
  ACCESS_LINK_TTL_MS, SESSION_FAMILY_TTL_MS, SESSION_TTL_MS, THROTTLE_RETENTION_MS,
  THROTTLE_WINDOW, addMilliseconds, customerId, decideThrottle, operationKey,
  type ThrottleDecision,
} from '../domain/customer-identity';

export type CustomerProfileRow = {
  id: string; primary_email: string; display_name: string | null; phone: string | null; version: number;
};
export type CustomerSessionRow = CustomerProfileRow & {
  session_id: string; family_id: string; identity_id: string; expires_at: string;
};
export type IssuedAccessLink = { challenge_id: string; expires_at: string };

/** Clave de idempotencia generada por SQLite: única por fila en una actualización masiva. */
const SQL_TRANSITION_KEY = "'auth:revoke:' || lower(hex(randomblob(16)))";

export function createD1CustomerAuth(db: D1Database) {
  async function readSession(tokenDigest: string, now: string): Promise<CustomerSessionRow | null> {
    return db.prepare(`SELECT s.id AS session_id,s.family_id,s.identity_id,s.expires_at,
        p.id,p.primary_email,p.display_name,p.phone,p.version
      FROM customer_sessions s
      JOIN customer_session_families f ON f.id=s.family_id AND f.status='active'
      JOIN customer_profiles p ON p.id=s.customer_profile_id AND p.status='active'
      WHERE s.token_digest=? AND s.status='active'
        AND julianday(s.expires_at) > julianday(?2)
        AND julianday(s.absolute_expires_at) > julianday(?2)
        AND julianday(f.absolute_expires_at) > julianday(?2)`)
      .bind(tokenDigest,now).first<CustomerSessionRow>();
  }
  /**
   * Perfil del correo, creándolo si es la primera vez que compra o entra. Dos
   * altas simultáneas comparten el mismo perfil: gana la primera y la segunda
   * lee su resultado en lugar de duplicarlo.
   */
  async function ensureProfile(email: string, contactHash: string, now: string): Promise<CustomerProfileRow> {
    await db.prepare(`INSERT INTO customer_profiles(
        id,primary_email,email_identity_hash,status,version,created_at,updated_at
      ) VALUES (?,?,?,'active',1,?,?) ON CONFLICT(email_identity_hash) DO NOTHING`)
      .bind(customerId('profile'),email,contactHash,now,now).run();
    // Un perfil fusionado conserva su correo: su cuenta vive en el destino.
    const profile = await db.prepare(`WITH resolved AS (
        SELECT COALESCE(merged_into_profile_id,id) AS id FROM customer_profiles WHERE email_identity_hash=?
      ) SELECT p.id,p.primary_email,p.display_name,p.phone,p.version
      FROM customer_profiles p JOIN resolved ON resolved.id=p.id WHERE p.status='active'`)
      .bind(contactHash).first<CustomerProfileRow>();
    if (!profile) throw new Error('customer_profile_unavailable');
    return profile;
  }
  return {
    /**
     * Cuenta los intentos de la ventana y guarda la decisión. La evidencia es
     * inmutable y solo contiene la huella del sujeto: nunca el correo.
     */
    async throttle(subjectDigest: string, now: string): Promise<ThrottleDecision> {
      const counts = await db.prepare(`SELECT
          COUNT(*) FILTER (WHERE julianday(occurred_at) > julianday(?2)) AS short,
          COUNT(*) AS daily
        FROM customer_auth_throttle_events
        WHERE scope='contact_start' AND subject_digest=?1 AND julianday(occurred_at) > julianday(?3)`)
        .bind(subjectDigest,addMilliseconds(now,-THROTTLE_WINDOW.short),addMilliseconds(now,-THROTTLE_WINDOW.daily))
        .first<{ short: number; daily: number }>();
      const decision = decideThrottle({ short: (counts?.short ?? 0) + 1, daily: (counts?.daily ?? 0) + 1 });
      await db.prepare(`INSERT INTO customer_auth_throttle_events(
          idempotency_key,scope,subject_digest,decision,short_window_count,daily_window_count,occurred_at,expires_at
        ) VALUES (?,'contact_start',?,?,?,?,?,?)`)
        .bind(`thr:start:${crypto.randomUUID().replaceAll('-','')}`,
          subjectDigest,decision.decision,decision.short_window_count,decision.daily_window_count,
          now,addMilliseconds(now,THROTTLE_RETENTION_MS)).run();
      return decision;
    },

    /**
     * Identidad de acceso del correo. El perfil puede existir ya por una compra
     * como invitado: entrar por primera vez no duplica su historial.
     */
    ensureProfile,

    async ensureIdentity(email: string, contactHash: string, now: string): Promise<{ profile: CustomerProfileRow; identity_id: string }> {
      const profile = await ensureProfile(email,contactHash,now);
      await db.prepare(`INSERT INTO customer_auth_identities(
          id,customer_profile_id,contact_identity_hash,status,created_at,creation_idempotency_key
        ) VALUES (?,?,?,'active',?,?) ON CONFLICT(contact_identity_hash) DO NOTHING`)
        .bind(customerId('identity'),profile.id,contactHash,now,operationKey('identity')).run();
      const identity = await db.prepare("SELECT id FROM customer_auth_identities WHERE contact_identity_hash=? AND status='active'")
        .bind(contactHash).first<{ id: string }>();
      if (!identity) throw new Error('customer_identity_revoked');
      return { profile, identity_id: identity.id };
    },

    /**
     * Emite el enlace de acceso. La base guarda su huella, el acuse de entrega
     * del buzón simulado y el correo ficticio, todo en la misma transacción:
     * un enlace visible siempre tiene su evidencia, y al revés.
     */
    async issueAccessLink(input: {
      identity_id: string; secret_digest: string; email: string; now: string; subject: string; body_html: string;
    }): Promise<IssuedAccessLink> {
      const challengeId = customerId('challenge');
      const providerReference = customerId('delivery');
      const expiresAt = addMilliseconds(input.now,ACCESS_LINK_TTL_MS);
      await db.batch([
        db.prepare(`INSERT INTO customer_passwordless_challenges(
            id,identity_id,method,purpose,provider_reference,secret_digest,status,requested_at,expires_at,version
          ) VALUES (?,?,'email_magic_link','sign_in',?,?,'pending',?,?,1)`)
          .bind(challengeId,input.identity_id,providerReference,input.secret_digest,input.now,expiresAt),
        db.prepare(`INSERT INTO customer_passwordless_challenge_deliveries(
            challenge_id,provider_reference,accepted_at,idempotency_key,created_at
          ) VALUES (?,?,?,?,?)`)
          .bind(challengeId,providerReference,input.now,operationKey('delivery'),input.now),
        db.prepare('INSERT INTO emails_outbox(to_addr,subject,body_html) VALUES (?,?,?)')
          .bind(input.email,input.subject,input.body_html),
      ]);
      return { challenge_id: challengeId, expires_at: expiresAt };
    },

    /**
     * Canjea el enlace por una sesión. El alta de la familia depende de que el
     * challenge siga pendiente, y la sesión de la familia: si otro navegador ya
     * lo usó, la transacción entera se deshace y el enlace no vale dos veces.
     */
    async consumeAccessLink(secretDigest: string, tokenDigest: string, now: string): Promise<CustomerSessionRow | null> {
      const challenge = await db.prepare(`SELECT c.id,c.identity_id,i.customer_profile_id
        FROM customer_passwordless_challenges c
        JOIN customer_auth_identities i ON i.id=c.identity_id AND i.status='active'
        WHERE c.secret_digest=? AND c.status='pending' AND julianday(c.expires_at) > julianday(?)`)
        .bind(secretDigest,now).first<{ id: string; identity_id: string; customer_profile_id: string }>();
      if (!challenge) return null;
      const familyId = customerId('family');
      const sessionId = customerId('session');
      const familyExpiresAt = addMilliseconds(now,SESSION_FAMILY_TTL_MS);
      try {
        await db.batch([
          db.prepare(`INSERT INTO customer_session_families(
              id,identity_id,customer_profile_id,status,created_at,absolute_expires_at,version
            ) SELECT ?1,?2,?3,'active',?4,?5,1 WHERE EXISTS (
              SELECT 1 FROM customer_passwordless_challenges WHERE id=?6 AND status='pending'
                AND julianday(expires_at) > julianday(?4))`)
            .bind(familyId,challenge.identity_id,challenge.customer_profile_id,now,familyExpiresAt,challenge.id),
          db.prepare(`INSERT INTO customer_sessions(
              id,family_id,identity_id,customer_profile_id,token_digest,can_revoke_sessions,status,
              issued_at,expires_at,absolute_expires_at,generation,version
            ) VALUES (?,?,?,?,?,1,'active',?,?,?,1,1)`)
            .bind(sessionId,familyId,challenge.identity_id,challenge.customer_profile_id,tokenDigest,
              now,addMilliseconds(now,SESSION_TTL_MS),familyExpiresAt),
          db.prepare(`UPDATE customer_passwordless_challenges
            SET status='consumed',consumed_at=?,consumed_by_session_id=?,transition_idempotency_key=?,version=version+1
            WHERE id=? AND status='pending'`)
            .bind(now,sessionId,operationKey('consume'),challenge.id),
        ]);
      } catch {
        return null;
      }
      return readSession(tokenDigest,now);
    },

    readSession,

    /** Cierra esta sesión y su familia. Repetirlo no falla: ya no hay nada activo. */
    async closeSession(session: { session_id: string; family_id: string }, reason: string, now: string): Promise<void> {
      await db.batch([
        db.prepare(`UPDATE customer_sessions SET status='revoked',revoked_at=?,revocation_reason_id=?,
          transition_idempotency_key=${SQL_TRANSITION_KEY},version=version+1 WHERE id=? AND status='active'`)
          .bind(now,reason,session.session_id),
        db.prepare(`UPDATE customer_session_families SET status='revoked',revoked_at=?,revocation_reason_id=?,
          transition_idempotency_key=${SQL_TRANSITION_KEY},version=version+1 WHERE id=? AND status='active'`)
          .bind(now,reason,session.family_id),
      ]);
    },

    /** Cierra todas las sesiones del perfil, incluidas las de otros navegadores. */
    async closeAllSessions(profileId: string, reason: string, now: string): Promise<number> {
      const result = await db.batch([
        db.prepare(`UPDATE customer_sessions SET status='revoked',revoked_at=?,revocation_reason_id=?,
          transition_idempotency_key=${SQL_TRANSITION_KEY},version=version+1
          WHERE customer_profile_id=? AND status='active'`).bind(now,reason,profileId),
        db.prepare(`UPDATE customer_session_families SET status='revoked',revoked_at=?,revocation_reason_id=?,
          transition_idempotency_key=${SQL_TRANSITION_KEY},version=version+1
          WHERE customer_profile_id=? AND status='active'`).bind(now,reason,profileId),
      ]);
      return Number(result[0]?.meta?.changes ?? 0);
    },

    /** Un enlace caducado o ya usado deja de contar como pendiente en el buzón. */
    async expireStaleChallenges(identityId: string, now: string): Promise<void> {
      await db.prepare(`UPDATE customer_passwordless_challenges
        SET status='expired',transition_idempotency_key=${SQL_TRANSITION_KEY},version=version+1
        WHERE identity_id=? AND status='pending' AND julianday(expires_at) <= julianday(?)`)
        .bind(identityId,now).run();
    },
  };
}
export type D1CustomerAuth = ReturnType<typeof createD1CustomerAuth>;
