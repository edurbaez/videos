// Generates MAPA.md: internal dependency graph, exports, endpoints, frontend → API and prompt usage.
// Usage: npm run mapa
const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const CARPETAS = ['lib', 'middleware', 'pipelines', 'routes', 'services', 'utils', 'scripts'];
const SUELTOS = ['server.js', 'scheduler.js'];

const rel = p => path.relative(RAIZ, p).split(path.sep).join('/');

function listarJs() {
  const archivos = SUELTOS.map(f => path.join(RAIZ, f)).filter(fs.existsSync);
  for (const c of CARPETAS) {
    const dir = path.join(RAIZ, c);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) archivos.push(path.join(dir, f));
  }
  return archivos.map(rel).sort((a, b) => (a.includes('/') - b.includes('/')) || a.localeCompare(b)).map(f => path.join(RAIZ, f));
}

function resolverRequire(desde, spec) {
  const base = path.resolve(path.dirname(desde), spec);
  for (const c of [base, base + '.js', path.join(base, 'index.js')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return rel(c);
  }
  return null;
}

function extraerExports(src) {
  const m = src.match(/module\.exports\s*=\s*([\s\S]*?);\s*$/m);
  if (!m) return [];
  const cuerpo = m[1].trim();
  if (!cuerpo.startsWith('{')) return [cuerpo];
  return cuerpo
    .replace(/^\{|\}$/g, '')
    .replace(/\/\/.*$/gm, '')
    .split(',')
    .map(s => s.trim().split(':')[0].trim())
    .filter(Boolean);
}

function analizar(archivo) {
  const src = fs.readFileSync(archivo, 'utf8');
  const internos = new Set();
  const externos = new Set();
  for (const [, spec] of src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (spec.startsWith('.')) {
      const r = resolverRequire(archivo, spec);
      if (r) internos.add(r);
    } else {
      externos.add(spec.split('/')[0].startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
    }
  }
  const rutas = [...src.matchAll(/router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)/g)]
    .map(([, metodo, ruta]) => `${metodo.toUpperCase()} ${ruta}`);
  const prompts = new Set();
  for (const [, carpeta, arch] of src.matchAll(/leerPromptArchivo\(\s*['"]([^'"]+)['"]\s*,\s*['"]?([^'")]+)/g)) {
    prompts.add(`prompts/${carpeta}/${arch.includes('.') ? arch : '*'}`);
  }
  return { internos: [...internos].sort(), externos: [...externos].sort(), exports: extraerExports(src), rutas, prompts: [...prompts] };
}

function analizarHtml() {
  const dir = path.join(RAIZ, 'public');
  const res = {};
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.html')).sort()) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const endpoints = new Set();
    for (const [, tipo, url] of src.matchAll(/(fetch|EventSource)\(\s*[`'"]([^`'"?]+)/g)) {
      endpoints.add(`${tipo === 'EventSource' ? 'SSE ' : ''}${url.replace(/\$\{[^}]+\}/g, ':id')}`);
    }
    const scripts = [...src.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(m => m[1]);
    res[f] = { endpoints: [...endpoints], scripts };
  }
  return res;
}

function generar() {
  const datos = {};
  for (const a of listarJs()) datos[rel(a)] = analizar(a);

  const usadoPor = {};
  for (const [f, d] of Object.entries(datos)) for (const i of d.internos) (usadoPor[i] ||= []).push(f);

  const out = [];
  out.push('# MAPA del código (generado)', '');
  out.push('> Generado por `npm run mapa` (`scripts/mapa.js`). No editar a mano: regenerar tras cambios de `require`, exports o rutas.', '');

  out.push('## Endpoints → archivo', '');
  for (const [f, d] of Object.entries(datos)) {
    if (!d.rutas.length) continue;
    out.push(`- **${f}**: ${d.rutas.map(r => `\`${r}\``).join(', ')}`);
  }
  out.push('');

  out.push('## Frontend → endpoints', '');
  for (const [f, d] of Object.entries(analizarHtml())) {
    out.push(`- **public/${f}**${d.scripts.length ? ` (scripts: ${d.scripts.join(', ')})` : ''}: ${d.endpoints.map(e => `\`${e}\``).join(', ') || '—'}`);
  }
  out.push('');

  out.push('## Módulos', '');
  out.push('`→` requiere · `←` usado por · `ext` dependencias npm/node', '');
  let carpetaActual = null;
  for (const [f, d] of Object.entries(datos)) {
    const carpeta = f.includes('/') ? f.split('/')[0] : '(raíz)';
    if (carpeta !== carpetaActual) {
      out.push(`### ${carpeta}`, '');
      carpetaActual = carpeta;
    }
    out.push(`**${f}**`);
    if (d.exports.length) out.push(`- exporta: ${d.exports.map(e => `\`${e}\``).join(', ')}`);
    if (d.internos.length) out.push(`- → ${d.internos.join(', ')}`);
    if (usadoPor[f]) out.push(`- ← ${usadoPor[f].sort().join(', ')}`);
    if (d.externos.length) out.push(`- ext: ${d.externos.join(', ')}`);
    if (d.prompts.length) out.push(`- prompts: ${d.prompts.join(', ')}`);
    out.push('');
  }

  const huerfanos = Object.keys(datos).filter(f => !usadoPor[f] && !SUELTOS.includes(f) && !f.startsWith('scripts/'));
  if (huerfanos.length) out.push('## Sin referencias internas', '', ...huerfanos.map(f => `- ${f}`), '');

  return out.join('\n');
}

fs.writeFileSync(path.join(RAIZ, 'MAPA.md'), generar());
console.log('MAPA.md generado');
