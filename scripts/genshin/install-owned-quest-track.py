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
engine=source/'Core/Script/EngineExtend.cs'
s=engine.read_text(encoding='utf-8')
if 'runOwnedQuestTrack' not in s:
    anchor='            engine.AddHostObject("isGameActive", (Func<bool>)OwnedGameFocus.IsGameActive);'
    addition='''
            engine.AddHostObject("runOwnedQuestTrack", (Func<int, System.Threading.CancellationToken, Task<string>>)((ms, ct) =>
                new BetterGenshinImpact.GameTask.AutoSkip.AutoTrackTask(new BetterGenshinImpact.GameTask.AutoSkip.Model.AutoTrackParam()).RunOwnedNearAsync(ms, ct)));'''
    assert s.count(anchor)==1
    engine.write_text(s.replace(anchor,anchor+addition),encoding='utf-8')
print('Installed owned near-tracking adapter; no path/CV reimplementation')
