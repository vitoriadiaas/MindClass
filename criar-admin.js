// Cria (ou lista) administradores. Uso:
//   npm run criar-admin
//   node criar-admin.js --nome "Maria Souza" --email maria@escola.com      (a senha é pedida no terminal)
// A conta de administrador NÃO pode ser criada pelo cadastro público.
import readline from 'node:readline';
import { db } from './db.js';
import { hashSenha, novoSalt, problemaSenha } from './auth.js';

const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let mudo = false;
const escrever = rl._writeToOutput?.bind(rl);
rl._writeToOutput = (s) => { if (!mudo) escrever(s); else if (s.includes('\n')) escrever('\n'); };
const perguntar = (q, oculto = false) => new Promise((ok) => { rl.question(q, (r) => { mudo = false; ok(r); }); mudo = oculto; });

const nome = (arg('nome') ?? await perguntar('Nome completo: ')).trim();
const email = (arg('email') ?? await perguntar('E-mail: ')).trim().toLowerCase();
if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { console.error('Nome ou e-mail inválido.'); process.exit(1); }
if (await db.get('SELECT 1 FROM usuarios WHERE email=?', email)) { console.error('Já existe uma conta com esse e-mail.'); process.exit(1); }

const senha = process.env.ADMIN_SENHA ?? await perguntar('Senha (mín. 8, com letra e número): ', true);
const pb = problemaSenha(senha, { email, nome });
if (pb) { console.error(pb); process.exit(1); }
const salt = novoSalt();
await db.run('INSERT INTO usuarios(nome,email,senha_hash,salt,perfil,senha_alterada_em,criado_em) VALUES(?,?,?,?,?,?,?)',
  nome, email, await hashSenha(senha, salt), salt, 'administrador', new Date().toISOString(), new Date().toISOString());
console.log(`\nAdministrador criado: ${email}\nAcesse em /#/entrar/administrador`);
console.log(`(gravado em ${db.tipo === 'postgres' ? 'PostgreSQL/Supabase' : 'SQLite local'})`);
rl.close();
await db.fechar?.();
