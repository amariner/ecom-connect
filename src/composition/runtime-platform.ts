import { platformManifest } from '../../platform.config';
import { createPlatform } from './create-platform';

/** Única fachada de capacidades consumida por la presentación Astro. */
export const runtimePlatform = createPlatform(platformManifest);
