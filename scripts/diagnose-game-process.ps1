# Read-only process token diagnostics. Does not send input or alter privileges.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GameTokenDiagnostic {
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token,int cls,IntPtr info,int length,out int needed);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
 [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid,uint index);
 public static string Read(int id) {
  IntPtr p=OpenProcess(0x1000,false,id), t=IntPtr.Zero, b=IntPtr.Zero;
  if(p==IntPtr.Zero)return "OpenProcess error="+Marshal.GetLastWin32Error();
  try {
   if(!OpenProcessToken(p,8,out t))return "OpenProcessToken error="+Marshal.GetLastWin32Error();
   int n; GetTokenInformation(t,25,IntPtr.Zero,0,out n);
   b=Marshal.AllocHGlobal(n);
   if(!GetTokenInformation(t,25,b,n,out n))return "GetTokenInformation error="+Marshal.GetLastWin32Error();
   IntPtr sid=Marshal.ReadIntPtr(b);
   byte count=Marshal.ReadByte(GetSidSubAuthorityCount(sid));
   int rid=Marshal.ReadInt32(GetSidSubAuthority(sid,(uint)(count-1)));
   return "integrityRid="+rid+" level="+(rid>=16384?"System":rid>=12288?"High":rid>=8192?"Medium":"Low");
  } finally {if(b!=IntPtr.Zero)Marshal.FreeHGlobal(b);if(t!=IntPtr.Zero)CloseHandle(t);CloseHandle(p);}
 }
}
'@
$results = @([PSCustomObject]@{ role='diagnostic_process'; processId=$PID; result=[GameTokenDiagnostic]::Read($PID) })
Get-CimInstance Win32_Process -Filter "name='Arknights.exe'" | ForEach-Object {
 $results += [PSCustomObject]@{role='game';processId=$_.ProcessId;result=[GameTokenDiagnostic]::Read($_.ProcessId)}
 $results += [PSCustomObject]@{role='game_parent';processId=$_.ParentProcessId;result=[GameTokenDiagnostic]::Read($_.ParentProcessId)}
}
Get-Process -Name Codex,node -ErrorAction SilentlyContinue | ForEach-Object {
 $results += [PSCustomObject]@{role=$_.ProcessName;processId=$_.Id;result=[GameTokenDiagnostic]::Read($_.Id)}
}
$results | ConvertTo-Json
