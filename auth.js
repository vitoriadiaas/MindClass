import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

export const novoSalt = () => crypto.randomBytes(16).toString('hex');
export const hashSenha = async (senha, salt) => (await scrypt(senha, salt, 64)).toString('hex');

const DUMMY_SALT = novoSalt();
const DUMMY_HASH = await hashSenha('senha-inexistente', DUMMY_SALT);

// Sempre calcula o hash (mesmo se o usuário não existir) para não revelar contas pelo tempo de resposta.
export async function confere(senha, usuario) {
  const calc = Buffer.from(await hashSenha(String(senha ?? '').slice(0, 200), usuario?.salt ?? DUMMY_SALT), 'hex');
  const esperado = Buffer.from(usuario?.senha_hash ?? DUMMY_HASH, 'hex');
  return crypto.timingSafeEqual(calc, esperado) && !!usuario;
}

const COMUNS = new Set(['12345678', '123456789', '1234567890', '87654321', 'qwertyui', 'password', 'password1', 'abc12345', 'senha123', 'senha12345', 'mudar123', 'admin123', 'admin1234', 'trocar123']);

// Devolve a mensagem do problema ou null se a senha for aceitável.
export function problemaSenha(senha, { email = '', nome = '' } = {}) {
  if (typeof senha !== 'string') return 'Informe a senha.';
  if (senha.length < 8 || senha.length > 100) return 'A senha deve ter de 8 a 100 caracteres.';
  if (!/[A-Za-zÀ-ÿ]/.test(senha) || !/\d/.test(senha)) return 'A senha deve ter pelo menos uma letra e um número.';
  const s = senha.toLowerCase();
  if (COMUNS.has(s) || /^(.)\1+$/.test(s)) return 'Essa senha é muito comum. Escolha outra.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && s.includes(local)) return 'A senha não pode conter o seu e-mail.';
  const primeiro = nome.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (primeiro.length >= 4 && s === primeiro) return 'A senha não pode ser o seu nome.';
  return null;
}
