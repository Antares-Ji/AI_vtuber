using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using MegaCrit.Sts2.Core.Models;

namespace STS2_MCP;

// Read-only addition to the pinned MCP mod. Never touches saves or discovery flags.
public static partial class McpMod
{
    private static void HandleLearningCatalog(HttpListenerRequest request, HttpListenerResponse response)
    {
        if (request.HttpMethod != "GET") { SendError(response, 405, "GET only"); return; }
        if (request.RemoteEndPoint == null || !IPAddress.IsLoopback(request.RemoteEndPoint.Address))
        { SendError(response, 403, "Loopback only"); return; }
        try
        {
            var result = RunOnMainThread(() => {
                var cards = new List<object>();
                var errors = new List<object>();
                var all = ModelDb.AllCards.ToList();
                foreach (var original in all)
                {
                    try
                    {
                        // Descriptions/upgrade previews operate on detached clones, not run cards.
                        var card = original.ToMutable();
                        var id = card.Id.Entry;
                        var entry = BuildWikiCardResult(new WikiCandidate("card", id,
                            SafeGetText(() => card.Title) ?? id, id, card, null), 1000);
                        entry["pool"] = SafeGetText(() => original.GetType().GetProperty("Pool")?.GetValue(original));
                        entry["model_class"] = original.GetType().FullName;
                        cards.Add(entry);
                    }
                    catch (Exception ex) { errors.Add(new { id = original.Id.Entry, error = ex.Message }); }
                }
                return new { schema = 1, source = "installed-game-ModelDb.AllCards", scope = "all_registered_cards",
                    captured_at = DateTime.UtcNow.ToString("o"), total = all.Count, exported = cards.Count, cards, errors };
            });
            SendJson(response, result.GetAwaiter().GetResult());
        }
        catch (Exception ex) { SendError(response, 500, ex.Message); }
    }
}
