// Cross-runtime golden vectors: Node's legacy v2 crypto -> .NET; .NET -> Node.
import { createCipheriv, createDecipheriv, scryptSync } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
const directory = new URL('../../.local/native-contract/', import.meta.url)
mkdirSync(directory, { recursive: true })
const password = '迁移-passphrase-🔐'
if (process.argv.includes('--verify')) {
  const env = JSON.parse(readFileSync(new URL('native-export.json', directory), 'utf8'))
  const b = env.enc
  const key = scryptSync(password, Buffer.from(b.salt, 'base64'), 32, { N:b.n, r:8, p:1, maxmem:64*1024*1024 })
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'))
  cipher.setAuthTag(Buffer.from(b.tag, 'base64'))
  const payload = JSON.parse(Buffer.concat([cipher.update(Buffer.from(b.cipher, 'base64')), cipher.final()]))
  if (payload.data.profiles[0].host !== '测试.example' || Object.values(payload.secrets)[0] !== 'secret-密码') throw Error('Native export incompatibility')
  console.log('Native export decrypted successfully using legacy Node crypto')
} else {
  const data = { groups:[{id:'group-1',name:'生产',parentId:null,order:0}], profiles:[{
    id:'profile-1',name:'服务器',groupId:'group-1',host:'测试.example',port:22,username:'user',
    auth:{method:'password',passwordRef:'password-1'}, terminal:{charset:'utf-8',termType:'xterm-256color'}, options:{}
  }], privateKeys:[{id:'key-1',name:'Missing managed key',path:'Z:/not-present/id_ed25519'}],
  knownHosts:[{key:'测试.example:22:ssh-ed25519',keyType:'ssh-ed25519',fingerprintSha256:'SHA256:abc',addedAt:0}],
  settings:{themeMode:'light',language:'zh-CN',rdpClientPath:'malicious.exe',profile:'windows-11'} }
  function seal(data, file) {
    const salt=Buffer.alloc(16,7), iv=Buffer.alloc(12,9)
    const key=scryptSync(password,salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024})
    const cipher=createCipheriv('aes-256-gcm',key,iv)
    const bytes=Buffer.concat([cipher.update(JSON.stringify({data,secrets:{'password-1':'secret-密码'}})),cipher.final()])
    const enc={kdf:'scrypt',n:32768,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),cipher:bytes.toString('base64')}
    writeFileSync(new URL(file,directory),JSON.stringify({app:'openfinalshell',formatVersion:2,appVersion:'contract',exportedAt:0,includesSecrets:true,note:'fixture',enc}))
  }
  seal(data,'legacy-export.json')
  seal({...data, profiles:[data.profiles[0],data.profiles[0]]},'invalid-export.json')
  console.log('Node v2 migration vectors generated')
}
