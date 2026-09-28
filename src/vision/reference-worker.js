const {spawn}=require('node:child_process');
const path=require('node:path');
const readline=require('node:readline');
class ReferenceWorker {
 constructor(root){
  this.pending=new Map();this.sequence=0;this.closed=false;
  this.child=spawn(path.join(root,'runtime/vlm-env/Scripts/python.exe'),['-u',path.join(root,'scripts/deployment-reference-check.py'),'--serve'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.ready=new Promise((resolve,reject)=>{this.resolveReady=resolve;this.rejectReady=reject;});
  this.child.stderr.on('data',()=>{});
  readline.createInterface({input:this.child.stdout}).on('line',line=>{
   try{
    const message=JSON.parse(line);
    if(message.ready){this.resolveReady();return;}
    const task=this.pending.get(message.id);if(!task)return;
    this.pending.delete(message.id);clearTimeout(task.timeout);
    message.error?task.reject(Error(message.error)):task.resolve(message);
   }catch(error){this.fail(error);}
  });
  this.child.on('error',error=>this.fail(error));
  this.child.on('exit',()=>this.fail(Error('Reference worker exited')));
  this.startup=setTimeout(()=>{this.fail(Error('Reference worker startup timeout'));this.close();},10000);
  this.ready.then(()=>clearTimeout(this.startup),()=>clearTimeout(this.startup));
 }
 fail(error){
  this.rejectReady(error);
  for(const task of this.pending.values()){clearTimeout(task.timeout);task.reject(error);}
  this.pending.clear();
 }
 async inspect(kind,image){
  await this.ready;if(this.closed)throw Error('Reference worker closed');
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const timeout=setTimeout(()=>{this.pending.delete(id);reject(Error('Reference check timeout'));},10000);
   this.pending.set(id,{resolve,reject,timeout});
   this.child.stdin.write(JSON.stringify({id,kind,image})+'\n',error=>{if(error){clearTimeout(timeout);this.pending.delete(id);reject(error);}});
  });
 }
 close(){this.closed=true;this.child.stdin.end();}
}
module.exports={ReferenceWorker};
