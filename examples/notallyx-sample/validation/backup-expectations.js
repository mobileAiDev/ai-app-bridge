'use strict';
const {PACKAGE,PICKER}=require('./backup-ui');
function expectedUi(phase,{filename,noteTitle}) {
  const settings=[{text:'导入备份'},{text:'导出备份'}],dialog=[{text:'备份密码'},
    {resourceName:'android:id/button1',text:'导入备份'},{resourceName:'android:id/button2',text:'取消'}];
  const row=(name,present,route=PACKAGE,absent=[])=>({name,present,route,absent});
  if(phase==='export')return [row('export-settings',settings),row('export-destination',[{text:'保存'},{className:'android.widget.EditText'}],PICKER),row('export-returned',settings)];
  if(phase==='delete')return [row('delete-before',[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}]),
    row('delete-trash',[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}]),row('delete-confirm',[{resourceName:'android:id/button1',text:'删除'},{resourceName:'android:id/button2',text:'取消'}]),
    row('delete-empty',[{text:'已删除'}],PACKAGE,[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}])];
  if(phase==='cold')return [row('cold-overview',[{resourceName:`${PACKAGE}:id/Title`,text:noteTitle}]),
    row('cold-editor',[{resourceName:`${PACKAGE}:id/EnterTitle`,text:noteTitle},{text:'Parent-A'},{text:'Child-A1'},{text:'Child-A2-edited'},{text:'Parent-B'}])];
  return [row(`${phase}-settings`,settings),row(`${phase}-picker`,[{displayFilename:filename}],PICKER),
    row(`${phase}-dialog`,dialog),row(`${phase}-returned`,settings,PACKAGE,dialog),row(`${phase}-usable`,[{text:'最近'},{text:'文件'}],PICKER),row(`${phase}-back`,settings)];
}
module.exports={expectedUi};
