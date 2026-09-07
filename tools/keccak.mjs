// Minimal keccak-256 (Ethereum variant: 0x01 padding, NOT NIST SHA3's 0x06).
// Verified against published private-key -> address vectors in newwallet.mjs.
const RC=[0x00000001n,0x00008082n,0x800000000000808an,0x8000000080008000n,0x000000000000808bn,
0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,0x000000000000008an,0x0000000000000088n,
0x0000000080008009n,0x000000008000000an,0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,
0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,
0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n];
const R=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]];
const M=(1n<<64n)-1n;
const rol=(x,n)=>n===0n?x:((x<<n)|(x>>(64n-n)))&M;
function f(S){
  for(let r=0;r<24;r++){
    const C=[0n,0n,0n,0n,0n];
    for(let x=0;x<5;x++) C[x]=S[x][0]^S[x][1]^S[x][2]^S[x][3]^S[x][4];
    for(let x=0;x<5;x++){ const D=C[(x+4)%5]^rol(C[(x+1)%5],1n);
      for(let y=0;y<5;y++) S[x][y]^=D; }
    const B=[[],[],[],[],[]];
    for(let x=0;x<5;x++) for(let y=0;y<5;y++)
      B[y][(2*x+3*y)%5]=rol(S[x][y],BigInt(R[x][y]));
    for(let x=0;x<5;x++) for(let y=0;y<5;y++)
      S[x][y]=B[x][y]^((~B[(x+1)%5][y]&M)&B[(x+2)%5][y]);
    S[0][0]^=RC[r];
  }
}
export function keccak256(bytes){
  const rate=136;
  const pad=rate-(bytes.length%rate);
  const buf=Buffer.concat([Buffer.from(bytes),Buffer.alloc(pad)]);
  buf[bytes.length]^=0x01; buf[buf.length-1]^=0x80;
  const S=[[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n],[0n,0n,0n,0n,0n]];
  for(let off=0;off<buf.length;off+=rate){
    for(let i=0;i<rate/8;i++){
      let w=0n;
      for(let b=7;b>=0;b--) w=(w<<8n)|BigInt(buf[off+i*8+b]);
      S[i%5][Math.floor(i/5)]^=w;
    }
    f(S);
  }
  const out=Buffer.alloc(32);
  for(let i=0;i<4;i++){
    let w=S[i%5][Math.floor(i/5)];
    for(let b=0;b<8;b++){ out[i*8+b]=Number(w&0xffn); w>>=8n; }
  }
  return out;
}
