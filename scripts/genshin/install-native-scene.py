"""Add a read-only, same-frame BGI CV observation to the pinned owned bridge."""
from pathlib import Path
root = Path(__file__).resolve().parents[2]
target = root / 'runtime/genshin/bettergi-chabao-b186/BetterGenshinImpact/Core/Script/EngineExtend.cs'
text = target.read_text(encoding='utf-8')
anchor = '                (Func<Mat, double, double, string>)OwnedMinimapProjection.GetJson);'
addition = '''
            engine.AddHostObject("getOwnedSceneObservation", (Func<ImageRegion, string>)(frame =>
            {
                var ui = BetterGenshinImpact.GameTask.Common.BgiVision.Bv.WhichGameUi(frame).ToString();
                var closable = ui == "Unknown" && BetterGenshinImpact.GameTask.Common.BgiVision.Bv.IsInAnyClosableUi(frame);
                var motion = ui == "Main" ? BetterGenshinImpact.GameTask.Common.BgiVision.Bv.GetMotionStatus(frame).ToString() : "Unknown";
                return System.Text.Json.JsonSerializer.Serialize(new { source = "bettergi_native_cv", ui, closable, motion });
            }));'''
if 'getOwnedSceneObservation' not in text:
    assert text.count(anchor) == 1, 'Unexpected pinned bridge source'
    target.write_text(text.replace(anchor, anchor + addition), encoding='utf-8')
print(str(target))
