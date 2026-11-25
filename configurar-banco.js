// Configura a conexão com o Supabase. Você digita a senha aqui, no seu terminal (ela não aparece na tela).
//   node configurar-banco.js
// Para usar outro endereço (ex.: Session pooler):
//   node configurar-banco.js --host aws-1-REGIAO.pooler.supabase.com --usuario postgres.REFERENCIA
// Grava o arquivo .env (que não entra no git) e testa a conexão.
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PROJETO = 'tcxiawzqjoqiutddbnix';
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
const HOST = arg('host') ?? `db.${PROJETO}.supabase.co`;
const USUARIO = arg('usuario') ?? 'postgres';
const PORTA = 5432;
const BANCO = 'postgres';

console.log(`Projeto: ${PROJETO}\nEndereço: ${HOST}:${PORTA}`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let mudo = false;
const escrever = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => { if (!mudo) escrever(s); else if (s.includes('\n')) escrever('\n'); };
const senha = await new Promise((ok) => { rl.question('Senha do banco no Supabase (não aparece ao digitar): ', ok); mudo = true; });
rl.close();
if (!senha) { console.error('Nenhuma senha digitada. Nada foi alterado.'); process.exit(1); }

const url = `postgresql://${USUARIO}:${encodeURIComponent(senha)}@${HOST}:${PORTA}/${BANCO}`;
writeFileSync(join(import.meta.dirname, '.env'), `# Gerado por "node configurar-banco.js". Não compartilhe este arquivo.\nDATABASE_URL=${url}\n`);
console.log('\nArquivo .env gravado. Testando a conexão…');

delete process.env.DB_PATH;
process.env.DATABASE_URL = url;
const { db } = await import('./db.js');                      // encerra com uma explicação se a conexão falhar
const n = async (t) => (await db.get(`SELECT COUNT(*) n FROM ${t}`)).n;
console.log(`Conectado ao Supabase: ${await n('usuarios')} conta(s), ${await n('turmas')} turma(s), ${await n('materias')} matéria(s).`);
console.log('\nPróximos passos:\n  node copiar-para-supabase.js --confirmar\n  node criar-admin.js\n  node server.js');
await db.fechar();
