/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.JsonObject;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static dev.mcplayeragent.harness.PlayerModelConnection.Backend.*;

class PlayerModelConnectionTest {
    @Test void authenticationAndBalanceErrorsAreActionableAndNeverEchoTheResponseBody() {
        var error = new dev.mcplayeragent.harness.ModelHttpException(401, "sensitive test payload", "api.deepseek.com");
        String message = PlayerModelConnection.error(new java.util.concurrent.CompletionException(error));
        assertTrue(message.contains("401")); assertFalse(message.contains("sensitive"));
        assertTrue(PlayerModelConnection.error(new dev.mcplayeragent.harness.ModelHttpException(402, "", "api.deepseek.com")).contains("余额"));
        assertTrue(PlayerModelConnection.error(new java.util.concurrent.TimeoutException()).contains("超时"));
    }
    @Test void bearerAuthenticationAndBatchedActionsRoundTripThroughExistingTransport() throws Exception {
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        var authorization = new java.util.concurrent.atomic.AtomicReference<String>();
        var received = new java.util.concurrent.atomic.AtomicReference<JsonObject>();
        server.createContext("/chat/completions", exchange -> {
            authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
            received.set(com.google.gson.JsonParser.parseString(new String(exchange.getRequestBody().readAllBytes(),
                    java.nio.charset.StandardCharsets.UTF_8)).getAsJsonObject());
            var message = new JsonObject(); message.addProperty("role", "assistant");
            message.addProperty("content", "{\"actions\":[{\"action\":\"INPUT\",\"forward\":1,\"sprint\":true},{\"action\":\"DONE\"}]}");
            message.addProperty("reasoning_content", "provider private reasoning is separate from the public plan");
            var choice = new JsonObject(); choice.add("message", message);
            var choices = new com.google.gson.JsonArray(); choices.add(choice);
            var reply = new JsonObject(); reply.add("choices", choices);
            byte[] bytes = reply.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length); exchange.getResponseBody().write(bytes); exchange.close();
        });
        server.start();
        try {
            var body = new PlayerModelConnection(DEEPSEEK, "https://api.deepseek.com", "deepseek-flash")
                    .request("Return JSON", new JsonObject());
            var reply = new dev.mcplayeragent.harness.ModelTransport()
                    .post("http://127.0.0.1:" + server.getAddress().getPort() + "/chat/completions", "test-key", body)
                    .get(10, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals("Bearer test-key", authorization.get());
            assertEquals("enabled", received.get().getAsJsonObject("thinking").get("type").getAsString());
            assertEquals("low", received.get().get("reasoning_effort").getAsString());
            var plan = PlayerDecision.parsePlan(PlayerModelConnection.PROVIDER.parseResponseBody(reply).content());
            assertEquals(2, plan.size()); assertTrue(plan.getFirst().sprint());
        } finally { server.stop(0); }
    }
    @Test void deepseekUsesOfficialUrlAndLowThinkingJsonProtocol() {
        var c = new PlayerModelConnection(DEEPSEEK, "https://api.deepseek.com/", "deepseek-flash");
        assertEquals("https://api.deepseek.com/chat/completions", c.url());
        JsonObject body = c.request("Return JSON actions", new JsonObject());
        assertFalse(body.get("stream").getAsBoolean());
        assertEquals("enabled", body.getAsJsonObject("thinking").get("type").getAsString());
        assertEquals("low",body.get("reasoning_effort").getAsString());
        assertTrue(body.get("max_tokens").getAsInt()>=8192);
        assertFalse(body.has("temperature"));
        assertEquals("json_object", body.getAsJsonObject("response_format").get("type").getAsString());
        assertEquals("deepseek-flash", body.get("model").getAsString());
        assertFalse(body.has("apiKey")); assertFalse(body.has("stream_options"));
    }
    @Test void localOllamaAndFullEndpointRemainSupported() {
        var c = new PlayerModelConnection(OLLAMA, "http://127.0.0.1:11434/v1/chat/completions/", "qwen3-minecraft:8b");
        assertEquals("http://127.0.0.1:11434/v1/chat/completions", c.url());
        assertFalse(c.request("json", new JsonObject()).has("thinking"));
    }
    @Test void officialKeyCannotBeConfiguredForAnImpersonatingHostOrCleartext() {
        for (String url : new String[]{"https://api.deepseek.com.evil.example", "http://api.deepseek.com",
                "https://api.deepseek.com@evil.example", "https://api.deepseek.com?key=secret", "https://api.deepseek.com:8443"})
            assertThrows(IllegalArgumentException.class, () -> new PlayerModelConnection(DEEPSEEK, url, "deepseek-flash"));
        assertThrows(IllegalArgumentException.class, () -> new PlayerModelConnection(OLLAMA, "http://remote.example/v1", "m"));
    }
    @Test void truncatedResponseCannotExecutePartialActions() {
        var body=com.google.gson.JsonParser.parseString("{\"choices\":[{\"finish_reason\":\"length\",\"message\":{\"content\":\"{}\"}}]}").getAsJsonObject();
        assertThrows(IllegalArgumentException.class,()->PlayerModelConnection.PROVIDER.parseResponseBody(body));
    }
    @Test void redirectsNeverForwardTheApiCredential() throws Exception {
        var redirected=new java.util.concurrent.atomic.AtomicBoolean();
        var server=com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1",0),0);
        server.createContext("/redirect",e->{ e.getResponseHeaders().set("Location","/destination"); e.sendResponseHeaders(307,-1); e.close(); });
        server.createContext("/destination",e->{ redirected.set(true); e.sendResponseHeaders(200,-1); e.close(); });
        server.start();
        try {
            var error=assertThrows(java.util.concurrent.ExecutionException.class,()->new ModelTransport()
                    .post("http://127.0.0.1:"+server.getAddress().getPort()+"/redirect","test-secret",new JsonObject()).get(10,java.util.concurrent.TimeUnit.SECONDS));
            assertInstanceOf(ModelHttpException.class,error.getCause()); assertFalse(redirected.get());
            assertFalse(error.toString().contains("test-secret"));
        } finally { server.stop(0); }
    }
}
