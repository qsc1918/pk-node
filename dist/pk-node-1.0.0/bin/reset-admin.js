'use strict';
// 重置本服务账号的管理员密码（忘记密码时用）。
//
// 用法：
//   node bin/reset-admin.js                 # 重置 admin -> admin
//   node bin/reset-admin.js 新密码           # 重置 admin -> 新密码
//   node bin/reset-admin.js 用户名 新密码     # 重置指定用户

const path = require('node:path');
const db = require(path.join(__dirname, '..', 'src', 'db'));
const { config } = require(path.join(__dirname, '..', 'src', 'config'));

db.init();

const arg1 = process.argv[2];
const arg2 = process.argv[3];

let username;
let password;
if (arg2) { username = arg1; password = arg2; }
else { username = config.defaultAdminUser; password = arg1 || config.defaultAdminPass; }

if (String(password).length < 6) {
  console.error('密码至少 6 位');
  process.exit(1);
}

const user = db.findUserByName(username);
if (!user) {
  console.error('用户不存在：' + username);
  process.exit(1);
}

db.setUserPassword(user.id, password);
db.get().prepare('UPDATE users SET role = ?, disabled = 0 WHERE id = ?').run('admin', user.id);
console.log('已重置：' + username + ' → ' + password + '（并确保为管理员身份）');