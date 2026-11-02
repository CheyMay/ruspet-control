import {randomBytes,scrypt as callbackScrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(callbackScrypt);
export async function hashPassword(password:string){
 const salt=randomBytes(16),value=await scrypt(password,salt,64) as Buffer;
 return `scrypt:${salt.toString('hex')}:${value.toString('hex')}`;
}
export async function verifyPassword(password:string,encoded:string){
 const [algorithm,saltHex,valueHex]=encoded.split(':');if(algorithm!=='scrypt'||!saltHex||!valueHex)return false;
 const expected=Buffer.from(valueHex,'hex'),actual=await scrypt(password,Buffer.from(saltHex,'hex'),expected.length) as Buffer;
 return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
