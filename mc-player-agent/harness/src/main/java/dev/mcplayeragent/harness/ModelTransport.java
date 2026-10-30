/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;
import com.google.gson.*;
import java.net.URI;
import java.net.http.*;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
/** Asynchronous model I/O; never follows redirects carrying credentials. */
public final class ModelTransport {
    private final HttpClient client=HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(20))
            .followRedirects(HttpClient.Redirect.NEVER).build();
    public CompletableFuture<JsonObject> post(String url,String key,JsonObject body) {
        URI uri=URI.create(url);
        var request=HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(120))
                .header("Content-Type","application/json");
        if(key!=null&&!key.isBlank()) request.header("Authorization","Bearer "+key);
        return client.sendAsync(request.POST(HttpRequest.BodyPublishers.ofString(body.toString())).build(),
                HttpResponse.BodyHandlers.ofString()).thenApply(reply->{
            if(reply.statusCode()<200||reply.statusCode()>=300) throw new ModelHttpException(reply.statusCode(),"",uri.getHost());
            return JsonParser.parseString(reply.body()).getAsJsonObject();
        });
    }
}
