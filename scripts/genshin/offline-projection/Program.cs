// Offline only: no BetterGI process, window handles, capture, or input APIs.
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using BetterGenshinImpact.Core.Recognition.OpenCv.FeatureMatch;
using OpenCvSharp;

if (args.Length != 5)
    throw new ArgumentException("Usage: OfflineProjection replay.json map-directory output.json limit native-source-root");
var replayPath = Path.GetFullPath(args[0]);
var mapDirectory = Path.GetFullPath(args[1]);
var outputPath = Path.GetFullPath(args[2]);
var limit = int.Parse(args[3]);
if (limit < 1 || limit > 200) throw new ArgumentOutOfRangeException(nameof(limit));
var sourceRoot = Path.GetFullPath(args[4]);
var jsonOptions = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
var files = new[] {
    Path.Combine(mapDirectory, "Teyvat_0_2048_SIFT.kp.bin"),
    Path.Combine(mapDirectory, "Teyvat_0_2048_SIFT.mat.png"),
    Path.Combine(sourceRoot, "BetterGenshinImpact/Core/Recognition/OpenCv/FeatureMatch/OwnedMinimapFeatureMatcher.cs"),
    Path.Combine(sourceRoot, "BetterGenshinImpact/Core/Recognition/OpenCv/FeatureMatch/OwnedProjectionGeometry.cs"),
};
string Hash(string file) { using var stream = File.OpenRead(file); return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant(); }
var provenance = files.Select(file => new { file, sha256 = Hash(file) }).ToArray();
var points = new List<KeyPoint>();
using (var reader = new BinaryReader(File.OpenRead(files[0]))) {
    if (reader.BaseStream.Length % 28 != 0) throw new InvalidDataException("Unexpected native KeyPoint layout");
    while (reader.BaseStream.Position < reader.BaseStream.Length)
        points.Add(new KeyPoint(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle(),
            reader.ReadSingle(), reader.ReadSingle(), reader.ReadInt32(), reader.ReadInt32()));
}
var trainPoints = points.ToArray();
using var bytes = new Mat(files[1], ImreadModes.Grayscale);
using var descriptors = new Mat();
bytes.ConvertTo(descriptors, MatType.CV_32FC1);
if (descriptors.Rows != trainPoints.Length || descriptors.Cols != 128)
    throw new InvalidDataException("Map descriptor and keypoint counts disagree");
using var document = JsonDocument.Parse(File.ReadAllText(replayPath));
var records = new List<object>();
var selected = document.RootElement.GetProperty("frames").EnumerateArray()
    .Where(row => row.GetProperty("accepted").GetBoolean()).Take(limit).ToArray();
if (selected.Length == 0) throw new InvalidDataException("No accepted candidates to project");
foreach (var row in selected) {
    var timer = Stopwatch.StartNew();
    var imageFile = row.GetProperty("image").GetString()!;
    if (Hash(imageFile) != row.GetProperty("sha256").GetString()) throw new InvalidDataException("Frame hash mismatch");
    using var image = new Mat(imageFile, ImreadModes.Color);
    var roi = row.GetProperty("roi").EnumerateArray().Select(v => v.GetInt32()).ToArray();
    var marker = row.GetProperty("candidate").GetProperty("center").EnumerateArray().Select(v => v.GetDouble()).ToArray();
    using var mini = new Mat(image, new Rect(roi[0], roi[1], roi[2], roi[3]));
    using var gray = new Mat();
    Cv2.CvtColor(mini, gray, ColorConversionCodes.BGR2GRAY);
    using var mask = Mat.Zeros(mini.Height, mini.Width, MatType.CV_8UC1).ToMat();
    var center = new Point(mini.Width / 2, mini.Height / 2);
    Cv2.Circle(mask, center, Math.Min(mini.Width, mini.Height) / 2 - 5, Scalar.White, -1);
    Cv2.Circle(mask, center, Math.Max(12, (int)Math.Round(mini.Width * 0.09)), Scalar.Black, -1);
    var localMarker = new OwnedProjectionPoint(marker[0] - roi[0], marker[1] - roi[1]);
    Cv2.Circle(mask, new Point((int)Math.Round(localMarker.X), (int)Math.Round(localMarker.Y)),
        Math.Max(16, (int)Math.Round(mini.Width * 0.09)), Scalar.Black, -1);
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
    OwnedProjectionQuality quality;
    try {
        quality = OwnedMinimapFeatureMatcher.Match(gray, mask, trainPoints, descriptors,
            localMarker, new Size(22 * 2048, 19 * 2048), timeout.Token);
    } catch (OperationCanceledException) { quality = new() { Reason = "cancelled" }; }
    var result = new {
        evidence = row.GetProperty("evidence").GetString(), image = imageFile,
        imageSha256 = row.GetProperty("sha256").GetString(), quality,
        durationMs = timer.ElapsedMilliseconds,
        headingDegrees = quality.GameDirection is { } direction
            ? (double?)(Math.Atan2(-direction.Y, -direction.X) * 180 / Math.PI) : null,
    };
    records.Add(result);
    // Flush each result so a bounded host timeout retains completed evidence.
    Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
    File.WriteAllText(outputPath, JsonSerializer.Serialize(new {
        kind = "offline_native_minimap_projection", inputCalls = 0, replay = replayPath,
        replaySha256 = Hash(replayPath), provenance, frames = records,
        requested = selected.Length, complete = records.Count == selected.Length,
        limitations = new[] { "No game arrival or input verification", "Masks mirror OwnedMinimapProjection; cancellation/lifecycle wrapper is not executed" },
    }, jsonOptions));
    Console.WriteLine(JsonSerializer.Serialize(new { quality.Ok, quality.Reason, quality.MatchCount,
        quality.InlierCount, result.durationMs, result.headingDegrees }));
}
