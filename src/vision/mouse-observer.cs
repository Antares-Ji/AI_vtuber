// Read-only input hooks, filtered to the selected foreground game. No text decoding or input injection.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
public static class VisionMouseObserver {
  delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
  delegate bool EnumProc(IntPtr handle, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct Mouse { public Point pt; public uint mouseData, flags, time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct Keyboard { public uint vk, scan, flags, time; public UIntPtr extra; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr handle, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out Rect rect, int size);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr handle, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
  [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
  [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
  static IntPtr target, hook, keyHook;
  static HookProc callback = Observe;
  static HookProc keyCallback = ObserveKey;
  static Dictionary<string,int> held = new Dictionary<string,int>();
  static int gesture;
  static long rawMouse, rawKeyboard, injectedMouse, injectedKeyboard, accepted, lastDiagnostic;
  static bool injected;
  static Queue<string> output=new Queue<string>();
  static volatile bool writing=true;
  const int OutputLimit=4096;
  static void Enqueue(string line) {
    lock(output) {
      if(!writing)return;
      if(output.Count>=OutputLimit) { writing=false;return; }
      output.Enqueue(line);
    }
  }
  static long lastMove;
  static Stopwatch clock = Stopwatch.StartNew();
  static string Title(IntPtr handle) { var text=new StringBuilder(512); GetWindowText(handle,text,512); return text.ToString(); }
  static bool Allowed(IntPtr handle) { return IsWindowVisible(handle) && Title(handle).Contains("明日方舟"); }
  public static void List() {
    EnumWindows((handle, unused) => {
      if (Allowed(handle)) Console.WriteLine(handle.ToInt64()+"\t"+Title(handle).Replace("\t"," ").Replace("\n"," ").Replace("\r"," "));
      return true;
    }, IntPtr.Zero);
  }
  static void Emit(string type, Mouse mouse, bool inside, string input, int id, int delta=0) {
    Rect r; if (DwmGetWindowAttribute(target,9,out r,Marshal.SizeOf(typeof(Rect))) != 0) GetWindowRect(target,out r);
    long at=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    string coords=inside ? ",\"x\":"+(mouse.pt.x-r.left)+",\"y\":"+(mouse.pt.y-r.top) : ",\"x\":null,\"y\":null";
    accepted++;
    Enqueue("{\"type\":\""+type+"\",\"input\":\""+input+"\",\"injected\":"+(injected?"true":"false")+",\"delta\":"+delta+",\"gesture\":"+id+",\"at\":"+at+",\"elapsedMs\":"+clock.ElapsedMilliseconds+coords+",\"width\":"+(r.right-r.left)+",\"height\":"+(r.bottom-r.top)+"}");
  }
  static void CancelAll() {
    foreach(var pair in held) Emit("cancel",new Mouse(),false,pair.Key,pair.Value);
    held.Clear();
  }
  static IntPtr ObserveKey(int code, IntPtr message, IntPtr data) {
    if(code>=0) {
      var k=(Keyboard)Marshal.PtrToStructure(data,typeof(Keyboard));
      rawKeyboard++;injected=(k.flags & 16)!=0;if(injected)injectedKeyboard++;
      {
        string input="key:"+k.vk+":"+k.scan+":"+(k.flags & 1);
        int kind=message.ToInt32();
        if(GetForegroundWindow()!=target) CancelAll();
        else if(kind==0x100 || kind==0x104) {
          if(!held.ContainsKey(input)) { held[input]=++gesture; Emit("down",new Mouse(),false,input,gesture); }
          else Emit("repeat",new Mouse(),false,input,held[input]);
        } else if((kind==0x101 || kind==0x105) && held.ContainsKey(input)) {
          Emit("up",new Mouse(),false,input,held[input]); held.Remove(input);
        }
      }
    }
    return CallNextHookEx(keyHook,code,message,data);
  }
  static IntPtr Observe(int code, IntPtr message, IntPtr data) {
    if (code>=0) {
      var m=(Mouse)Marshal.PtrToStructure(data,typeof(Mouse));
      rawMouse++;injected=(m.flags & 1)!=0;if(injected)injectedMouse++;
      int kind=message.ToInt32();
      bool inside=AcceptMouse(GetAncestor(WindowFromPoint(m.pt),2)==target,GetForegroundWindow()==target,kind);
      {
        string button=kind==0x201||kind==0x202?"mouse:left":kind==0x204||kind==0x205?"mouse:right":kind==0x207||kind==0x208?"mouse:middle":kind==0x20B||kind==0x20C?"mouse:x"+((m.mouseData>>16)&65535):null;
        bool down=kind==0x201||kind==0x204||kind==0x207||kind==0x20B;
        if(button!=null && down && inside) { held[button]=++gesture;Emit("down",m,true,button,gesture); }
        else if(button!=null && !down && held.ContainsKey(button)) { Emit(inside?"up":"cancel",m,inside,button,held[button]);held.Remove(button); }
        else if((kind==0x20A || kind==0x20E) && inside) { Emit("wheel",m,true,kind==0x20A?"wheel:vertical":"wheel:horizontal",++gesture,(short)(m.mouseData>>16)); }
        else if (kind==0x200 && held.Count>0 && clock.ElapsedMilliseconds-lastMove>=20) {
          if (!inside) { CancelAll(); }
          else { lastMove=clock.ElapsedMilliseconds; foreach(var pair in held) if(pair.Key.StartsWith("mouse:")) Emit("move",m,true,pair.Key,pair.Value); }
        }
        else if(kind==0x200 && held.Count==0 && inside && clock.ElapsedMilliseconds-lastMove>=20) {
          lastMove=clock.ElapsedMilliseconds;Emit("hover",m,true,"mouse:pointer",0);
        }
      }
    }
    return CallNextHookEx(hook,code,message,data);
  }
  public static bool AcceptMouse(bool pointingAtTarget, bool foreground, int message) {
    bool activating=message==0x201||message==0x204||message==0x207||message==0x20B;
    return pointingAtTarget && (foreground || activating);
  }
  public static void SelfTest() {
    if(!AcceptMouse(true,false,0x201))throw new Exception("Activation click lost");
    if(AcceptMouse(false,true,0x201))throw new Exception("Outside click admitted");
    if(AcceptMouse(true,false,0x200))throw new Exception("Unfocused move admitted");
    if(!AcceptMouse(true,true,0x20A))throw new Exception("Wheel lost");
    for(int i=0;i<OutputLimit;i++)Enqueue("test");
    if(!writing || output.Count!=OutputLimit)throw new Exception("Premature queue stop");
    Enqueue("overflow");
    if(writing || output.Count!=OutputLimit)throw new Exception("Queue must stop without growing");
    output.Clear();writing=true;
    Console.WriteLine("Observer target policy and bounded output queue passed; no hook installed, no input injected.");
  }
  public static void Run(long handle, int parentProcessId) {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); target=new IntPtr(handle);
    if (!Allowed(target)) throw new Exception("Target is not a visible Arknights window");
    hook=SetWindowsHookEx(14,callback,GetModuleHandle(null),0);
    if (hook==IntPtr.Zero) throw new Exception("Mouse hook unavailable");
    keyHook=SetWindowsHookEx(13,keyCallback,GetModuleHandle(null),0);
    if(keyHook==IntPtr.Zero) { UnhookWindowsHookEx(hook);throw new Exception("Keyboard hook unavailable"); }
    var writer=new System.Threading.Thread(()=>{
      try { while(writing) {
        string line=null; lock(output) { if(output.Count>0)line=output.Dequeue(); }
        if(line!=null){Console.WriteLine(line);Console.Out.Flush();}else System.Threading.Thread.Sleep(5);
      }} catch { writing=false; }
    });writer.IsBackground=true;writer.Start();
    var timer=new Timer(); timer.Interval=20;
    timer.Tick+=(sender,args)=>{
      if(!writing)Application.ExitThread();
      if(clock.ElapsedMilliseconds-lastDiagnostic>=1000) {
        lastDiagnostic=clock.ElapsedMilliseconds;
        Enqueue("{\"type\":\"diagnostic\",\"rawMouse\":"+rawMouse+",\"rawKeyboard\":"+rawKeyboard+",\"injectedMouse\":"+injectedMouse+",\"injectedKeyboard\":"+injectedKeyboard+",\"accepted\":"+accepted+",\"targetForeground\":"+(GetForegroundWindow()==target?"true":"false")+"}");
      }
      if (!Allowed(target) || clock.ElapsedMilliseconds>600000) Application.ExitThread();
      if (parentProcessId>0) { try { if (Process.GetProcessById(parentProcessId).HasExited) Application.ExitThread(); } catch { Application.ExitThread(); } }
      if (held.Count>0 && GetForegroundWindow()!=target) CancelAll();
    };
    timer.Start(); Enqueue("{\"type\":\"ready\"}");
    try { Application.Run(); } finally { timer.Stop(); UnhookWindowsHookEx(hook);UnhookWindowsHookEx(keyHook);writing=false; }
  }
}
