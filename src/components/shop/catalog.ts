export const categories = [
  {id:'facial', name:'Cuidado facial', short:'Facial', icon:'face', color:'#eadfd8'},
  {id:'dermocosmetica', name:'Dermocosmética', short:'Dermocosmética', icon:'drop', color:'#e1e6d9'},
  {id:'capilar', name:'Cuidado capilar', short:'Capilar', icon:'bottle', color:'#f0e2cf'},
  {id:'higiene', name:'Higiene diaria', short:'Higiene', icon:'sparkle', color:'#dee5e4'},
  {id:'bebe', name:'Bebé y mamá', short:'Bebé y mamá', icon:'heart', color:'#efe2df'},
  {id:'nutricion', name:'Nutrición', short:'Nutrición', icon:'leaf', color:'#e8e5cf'},
  {id:'bienestar', name:'Bienestar', short:'Bienestar', icon:'flower', color:'#e3dfec'},
  {id:'ortopedia', name:'Ortopedia ligera', short:'Ortopedia', icon:'cross', color:'#e0e5e6'},
  {id:'solares', name:'Protección solar', short:'Solares', icon:'sun', color:'#f4e2b9'},
] as const;
export const euros = (value: number) => new Intl.NumberFormat('es-ES', {style:'currency',currency:'EUR'}).format(value / 100);
export const categoryName = (id: string) => categories.find(category => category.id === id)?.name ?? id;
