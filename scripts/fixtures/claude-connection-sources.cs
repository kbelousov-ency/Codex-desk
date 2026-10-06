using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

// Local protocol fixture: never authenticates, invokes a model, or accesses the network.
public class ClaudeConnectionSourcesFixture {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    static readonly string Config = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
    static readonly int Pid = Process.GetCurrentProcess().Id;
    static string Env(string key) { return Environment.GetEnvironmentVariable(key) ?? ""; }
    static void Log(object entry) { File.AppendAllText(Path.Combine(Config, "source-" + Pid + ".jsonl"), Json.Serialize(entry) + "\n", Utf8); }
    static void Send(object frame) { Console.WriteLine(Json.Serialize(frame)); }
    public static int Main(string[] args) {
        if (String.IsNullOrEmpty(Config) || !File.Exists(Path.Combine(Config, "isolated.fixture"))) return 2;
        Console.InputEncoding = Utf8; Console.OutputEncoding = Utf8;
        Dictionary<string, object> overrides = new Dictionary<string, object>();
        string settingsFile = null;
        for (int i = 0; i + 1 < args.Length; i++) if (args[i] == "--settings") settingsFile = args[i + 1];
        if (settingsFile != null) overrides = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsFile, Utf8));
        var settingsEnv = overrides.ContainsKey("env") ? (Dictionary<string, object>)overrides["env"] : new Dictionary<string, object>();
        Log(new { type = "spawn", pid = Pid, startedAt = DateTime.UtcNow.ToString("o"), args = args, cwd = Directory.GetCurrentDirectory(), configDirectory = Config,
            baseUrl = Env("ANTHROPIC_BASE_URL"), bearerSet = Env("ANTHROPIC_AUTH_TOKEN").Length > 0,
            apiKeySet = Env("ANTHROPIC_API_KEY").Length > 0, oauthSet = Env("CLAUDE_CODE_OAUTH_TOKEN").Length > 0,
            opus = Env("ANTHROPIC_DEFAULT_OPUS_MODEL"), settingsFile = settingsFile,
            settingsBearerSet = settingsEnv.ContainsKey("ANTHROPIC_AUTH_TOKEN") && ((string)settingsEnv["ANTHROPIC_AUTH_TOKEN"]).Length > 0,
            helperDisabled = overrides.ContainsKey("apiKeyHelper") && (string)overrides["apiKeyHelper"] == "" });
        if (args.Length == 2 && args[0] == "auth" && args[1] == "status") {
            Send(new { loggedIn = true, authMethod = "fixture", apiProvider = "firstParty" }); return 0;
        }
        if (args.Length == 0 || args[0] != "-p") return 2;
        string line;
        while ((line = Console.ReadLine()) != null) {
            var frame = Json.Deserialize<Dictionary<string, object>>(line);
            if ((string)frame["type"] != "control_request") { Log(new { type = "forbidden_model_input" }); return 3; }
            var request = (Dictionary<string, object>)frame["request"];
            string subtype = (string)request["subtype"];
            Log(new { type = "control", subtype = subtype });
            object result = new { };
            if (subtype == "initialize") result = new { models = new object[] { new { value = "fixture-claude", displayName = "Fixture Claude", supportedEffortLevels = new[] { "medium", "high" } } }, account = new { }, current_permission_mode = "default" };
            else if (subtype == "get_settings") result = new { applied = new { model = "fixture-claude", effort = "high" }, effective = new { env = settingsEnv } };
            else if (subtype == "get_binary_version") result = new { version = "2.1.278-fixture" };
            else if (subtype == "mcp_status") result = new { mcpServers = new object[0] };
            Send(new { type = "control_response", response = new { subtype = "success", request_id = frame["request_id"], response = result } });
        }
        return 0;
    }
}
