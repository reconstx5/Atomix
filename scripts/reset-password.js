// Reset a user's password from the command line (e.g. a forgotten admin password).
//   npm run reset-password -- <username> <new-password>
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { hashPassword, validatePassword } from '../src/auth.js';

const [username, password] = process.argv.slice(2);
if (!username || !password) {
  console.log('Usage: npm run reset-password -- <username> <new-password>');
  process.exit(1);
}
try {
  validatePassword(password);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const config = loadConfig();
const db = openDatabase(config.dbFile);
const user = db.get('SELECT id, username, role FROM users WHERE username = ?', username);
if (!user) {
  const all = db.all('SELECT username, role FROM users').map((u) => `${u.username} (${u.role})`);
  console.error(`No user called "${username}". Users: ${all.join(', ') || 'none — open the web page to run setup'}`);
  process.exit(1);
}
db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
console.log(`Password for ${user.username} (${user.role}) was reset. They'll need to sign in again.`);
db.close();
