"""Expose the pinned BGI AutoTrackTask through an owned, bounded awaitable adapter."""
from pathlib import Path
root=Path(__file__).resolve().parents[2]
source=root/'runtime/genshin/bettergi-chabao-b186/BetterGenshinImpact'
target=source/'GameTask/AutoSkip/AutoTrackTask.cs'
s=target.read_text(encoding='utf-8')
if 'RunOwnedNearAsync' not in s:
    anchor='    private CancellationToken _ct;'
    addition=r'''

    private bool _ownedNear;
    private string _ownedStop = "returned";
    private int _ownedMissing;
    private int _ownedFrames;
    // The JS task already owns TaskSemaphore. Do not call async-void Start or
    // acquire it again. Reuse BGI's near tracking and native recognizers only.
    public System.Threading.Tasks.Task<string> RunOwnedNearAsync(int timeoutMs, CancellationToken parent)
    {
        return System.Threading.Tasks.Task.Run(() =>
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(parent,
                BetterGenshinImpact.Service.Execution.ExecutionScope.Current!.Token);
            linked.CancelAfter(Math.Clamp(timeoutMs, 1000, 30000));
            _ct = linked.Token;
            _ownedNear = true;
            var watch = Stopwatch.StartNew();
            try
            {
                CheckOwnedNear();
                using var ra = CaptureToRectArea();
                using var paimon = ra.Find(ElementRecognition.Get("PaimonMenu", ra));
                if (!paimon.IsExist()) throw new NormalEndException("native_world_changed");
                var distance = GetDistanceFromMissionText(OcrMissionTextRaList(paimon));
                if (distance < 0 || distance > 150) throw new NormalEndException("native_distance_unavailable_or_far");
                CheckOwnedNear();
                InputHub.Foreground.Mouse.MoveMouseBy(0, 7000);
                Sleep(500, _ct);
                CheckOwnedNear();
                StartTrackPoint();
            }
            catch (OperationCanceledException) { _ownedStop = "cancelled_or_budget"; }
            catch (NormalEndException e) { _ownedStop = e.Message; }
            finally
            {
                InputHub.Foreground.SimulateAction(GIActions.MoveForward, KeyType.KeyUp);
                _ownedNear = false;
            }
            return System.Text.Json.JsonSerializer.Serialize(new {
                kind = "bgi-native-track", implementation = "AutoTrackTask.StartTrackPoint",
                stopReason = _ownedStop, durationMs = watch.ElapsedMilliseconds,
                frames = _ownedFrames, verified = false
            });
        });
    }

    private void CheckOwnedNear()
    {
        if (!_ownedNear) return;
        _ct.ThrowIfCancellationRequested();
        if (!BetterGenshinImpact.Core.Script.Dependence.OwnedGameFocus.IsGameActive()) throw new NormalEndException("focus_lost");
        using var frame = CaptureToRectArea();
        if (!Bv.IsInMainUi(frame)) throw new NormalEndException("native_world_changed");
        _ownedFrames++;
    }
'''
    assert s.count(anchor)==1
    s=s.replace(anchor,anchor+addition)
    s=s.replace('    private void StartTrackPoint()\n    {','    private void StartTrackPoint()\n    {\n        CheckOwnedNear();')
    s=s.replace('        while (!_ct.IsCancellationRequested)\n        {','        while (!_ct.IsCancellationRequested)\n        {\n            CheckOwnedNear();',1)
    s=s.replace('            if (blueTrackPointRa.IsExist())\n            {','            if (blueTrackPointRa.IsExist())\n            {\n                _ownedMissing = 0;',1)
    s=s.replace('                // 随机移动\n                Logger.LogInformation("未找到追踪点");','                // No guessed movement when native BGI marker recognition fails.\n                if (_ownedNear && ++_ownedMissing >= 10) throw new NormalEndException("native_marker_missing");\n                Logger.LogInformation("未找到追踪点");')
    s=s.replace('            Logger.LogWarning("首次未找到追踪点");','            Logger.LogWarning("首次未找到追踪点");\n            if (_ownedNear) _ownedStop = "native_marker_missing";')
    target.write_text(s,encoding='utf-8')
s=target.read_text(encoding='utf-8')
s=s.replace('if (!OwnedGameFocus.IsGameActive())', 'if (!BetterGenshinImpact.Core.Script.Dependence.OwnedGameFocus.IsGameActive())')
target.write_text(s,encoding='utf-8')
if 'RunOwnedEscapeAsync' not in s:
    marker='    private void CheckOwnedNear()'
    extra=r'''
    public async System.Threading.Tasks.Task<string> RunOwnedEscapeAsync(CancellationToken parent)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(parent,
            BetterGenshinImpact.Service.Execution.ExecutionScope.Current!.Token);
        linked.CancelAfter(5000);
        _ct = linked.Token; _ownedNear = true;
        var watch = Stopwatch.StartNew();
        var reason = "returned";
        try
        {
            CheckOwnedNear();
            await new BetterGenshinImpact.GameTask.AutoPathing.TrapEscaper(_ct, CheckOwnedNear).RotateAndMove();
            _ct.ThrowIfCancellationRequested();
        }
        catch (OperationCanceledException) { reason = "cancelled_or_budget"; }
        catch (NormalEndException e) { reason = e.Message; }
        finally
        {
            foreach (var action in new[] {GIActions.MoveForward, GIActions.MoveBackward, GIActions.MoveLeft, GIActions.MoveRight, GIActions.Jump})
                InputHub.Foreground.SimulateAction(action, KeyType.KeyUp);
            _ownedNear = false;
        }
        return System.Text.Json.JsonSerializer.Serialize(new {kind="bgi-native-unstuck",
            implementation="TrapEscaper.RotateAndMove", stopReason=reason,
            durationMs=watch.ElapsedMilliseconds, verified=false});
    }

'''
    assert s.count(marker)==1
    s=s.replace(marker,extra+marker)
    s=s.replace('                StartTrackPoint();\n            }\n            catch', '                StartTrackPoint();\n                _ct.ThrowIfCancellationRequested();\n            }\n            catch',1)
    target.write_text(s,encoding='utf-8')
trap=source/'GameTask/AutoPathing/TrapEscaper.cs'
t=trap.read_text(encoding='utf-8')
if 'Action? checkInput' not in t:
    t=t.replace('public class TrapEscaper(CancellationToken ct)', 'public class TrapEscaper(CancellationToken ct, Action? checkInput = null)')
    lines=[]
    for line in t.splitlines():
        if 'InputHub.Foreground.' in line and 'KeyType.KeyUp' not in line:
            lines.append(line[:len(line)-len(line.lstrip())]+'checkInput?.Invoke();')
        lines.append(line)
    t='\n'.join(lines)+'\n'
    import re
    t=re.sub(r'Sleep\((75|700|500|300|delay)\);',r'Sleep(\1, ct);',t)
    trap.write_text(t,encoding='utf-8')
s=target.read_text(encoding='utf-8')
if '_ownedForwardStarts' not in s:
    s=s.replace('    private int _ownedFrames;', '    private int _ownedFrames;\n    private int _ownedTurns;\n    private int _ownedForwardStarts;\n    private bool _ownedEscaping;')
    s=s.replace('_ct = linked.Token; _ownedNear = true;', '_ct = linked.Token; _ownedNear = true; _ownedEscaping = true;')
    s=s.replace('                frames = _ownedFrames, verified = false', '                frames = _ownedFrames, turns = _ownedTurns, forwardStarts = _ownedForwardStarts, verified = false')
    s=s.replace('                    InputHub.Foreground.Mouse.MoveMouseBy(moveX, 0);', '                    if (_ownedNear) _ownedTurns++;\n                    InputHub.Foreground.Mouse.MoveMouseBy(moveX, 0);')
    s=s.replace('                        InputHub.Foreground.SimulateAction(GIActions.MoveForward, KeyType.KeyDown);', '                        if (_ownedNear) _ownedForwardStarts++;\n                        InputHub.Foreground.SimulateAction(GIActions.MoveForward, KeyType.KeyDown);')
    s=s.replace('        _ownedFrames++;', '        if (!_ownedEscaping && Bv.FindF(frame)) throw new NormalEndException("native_interaction_prompt");\n        _ownedFrames++;')
    target.write_text(s,encoding='utf-8')
engine=source/'Core/Script/EngineExtend.cs'
s=engine.read_text(encoding='utf-8')
if 'runOwnedQuestTrack' not in s:
    anchor='            engine.AddHostObject("isGameActive", (Func<bool>)OwnedGameFocus.IsGameActive);'
    addition='''
            engine.AddHostObject("runOwnedQuestTrack", (Func<int, System.Threading.CancellationToken, Task<string>>)((ms, ct) =>
                new BetterGenshinImpact.GameTask.AutoSkip.AutoTrackTask(new BetterGenshinImpact.GameTask.AutoSkip.Model.AutoTrackParam()).RunOwnedNearAsync(ms, ct)));'''
    assert s.count(anchor)==1
    engine.write_text(s.replace(anchor,anchor+addition),encoding='utf-8')
s=engine.read_text(encoding='utf-8')
if 'runOwnedQuestUnstuck' not in s:
    anchor='            engine.AddHostObject("isGameActive", (Func<bool>)OwnedGameFocus.IsGameActive);'
    addition='''
            engine.AddHostObject("runOwnedQuestUnstuck", (Func<System.Threading.CancellationToken, Task<string>>)(ct =>
                new BetterGenshinImpact.GameTask.AutoSkip.AutoTrackTask(new BetterGenshinImpact.GameTask.AutoSkip.Model.AutoTrackParam()).RunOwnedEscapeAsync(ct)));'''
    engine.write_text(s.replace(anchor,anchor+addition),encoding='utf-8')
print('Installed owned near-tracking adapter; no path/CV reimplementation')

s=target.read_text(encoding='utf-8')
if '_ownedBestDistance' not in s:
    s=s.replace('    private bool _ownedEscaping;', '''    private bool _ownedEscaping;
    private string _ownedIgnoredF = "";
    private int _ownedBestDistance = int.MaxValue;
    private int _ownedEscapes;
    private DateTime _ownedLastProgress = DateTime.UtcNow;
    private DateTime _ownedLastDistanceRead = DateTime.MinValue;
    private BetterGenshinImpact.GameTask.AutoPathing.TrapEscaper? _ownedTrap;''')
    s=s.replace('RunOwnedNearAsync(int timeoutMs, CancellationToken parent)', 'RunOwnedNearAsync(int timeoutMs, string ignoredF, CancellationToken parent)')
    s=s.replace('            _ownedNear = true;\n            var watch', '            _ownedNear = true;\n            _ownedIgnoredF = ignoredF ?? "";\n            _ownedTrap = new BetterGenshinImpact.GameTask.AutoPathing.TrapEscaper(_ct, CheckOwnedNear);\n            var watch',1)
    s=s.replace('forwardStarts = _ownedForwardStarts, verified = false', 'forwardStarts = _ownedForwardStarts, recoveryCalls = _ownedEscapes, bestHudDistance = _ownedBestDistance == int.MaxValue ? (int?)null : _ownedBestDistance, verified = false')
    s=s.replace('        if (!_ownedEscaping && Bv.FindF(frame)) throw new NormalEndException("native_interaction_prompt");', '''        if (!_ownedEscaping && Bv.FindF(frame))
        {
            var label = Bv.FindFKeyText(frame).Replace(" ", "").Trim();
            if (string.IsNullOrWhiteSpace(_ownedIgnoredF) || label != _ownedIgnoredF.Replace(" ", "").Trim())
                throw new NormalEndException("native_interaction_prompt");
        }''')
    anchor='''            CheckOwnedNear();
            using var ra = CaptureToRectArea();
            var blueTrackPointRa = ra.Find(ElementRecognition.Get("BlueTrackPoint", ra));'''
    addition='''            CheckOwnedNear();
            using var ra = CaptureToRectArea();
            if (_ownedNear && _missionDistanceRect.Width > 0 && (DateTime.UtcNow - _ownedLastDistanceRead).TotalSeconds >= 1)
            {
                _ownedLastDistanceRead = DateTime.UtcNow;
                using var distanceRegion = ra.CacheGreyMat[_missionDistanceRect];
                var distance = StringUtils.TryExtractPositiveInt(OcrFactory.Paddle.OcrWithoutDetector(distanceRegion));
                if (distance >= 0 && distance < _ownedBestDistance)
                {
                    _ownedBestDistance = distance;
                    _ownedLastProgress = DateTime.UtcNow;
                }
                if (distance is >= 0 and <= 3) throw new NormalEndException("native_near_hud");
                if (distance >= 0 && wDown && (DateTime.UtcNow - _ownedLastProgress).TotalSeconds > 4)
                {
                    if (_ownedEscapes >= 3) throw new NormalEndException("native_stalled_after_recovery");
                    InputHub.Foreground.SimulateAction(GIActions.MoveForward, KeyType.KeyUp);
                    wDown = false;
                    _ownedEscaping = true;
                    try { _ownedTrap!.RotateAndMove().GetAwaiter().GetResult(); _ownedEscapes++; }
                    finally { _ownedEscaping = false; }
                    _ownedLastProgress = DateTime.UtcNow;
                    prevMoveX = 0;
                    continue;
                }
            }
            var blueTrackPointRa = ra.Find(ElementRecognition.Get("BlueTrackPoint", ra));'''
    assert s.count(anchor)==1, 'Pinned native loop changed'
    s=s.replace(anchor,addition)
    # Recovery can hold lateral keys when cancellation interrupts Sleep.
    s=s.replace('''                InputHub.Foreground.SimulateAction(GIActions.MoveForward, KeyType.KeyUp);
                _ownedNear = false;''', '''                foreach (var action in new[] {GIActions.MoveForward, GIActions.MoveBackward, GIActions.MoveLeft, GIActions.MoveRight, GIActions.Jump})
                    InputHub.Foreground.SimulateAction(action, KeyType.KeyUp);
                _ownedNear = false;''',1)
    target.write_text(s,encoding='utf-8')
s=engine.read_text(encoding='utf-8')
s=s.replace('Func<int, System.Threading.CancellationToken, Task<string>>)((ms, ct)', 'Func<int, string, System.Threading.CancellationToken, Task<string>>)((ms, ignored, ct)')
s=s.replace('.RunOwnedNearAsync(ms, ct)', '.RunOwnedNearAsync(ms, ignored, ct)')
engine.write_text(s,encoding='utf-8')
