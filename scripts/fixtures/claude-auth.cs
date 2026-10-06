using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Local-only executable: neither browser, credentials, model nor network access.
public class ClaudeAuthFixture {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string Cwd = Directory.GetCurrentDirectory();
    static readonly int Pid = Process.GetCurrentProcess().Id;
    static readonly string Config = Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR");
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    static bool IsConsole(int id) { uint mode; return GetConsoleMode(GetStdHandle(id), out mode); }
    static void Log(object entry) { File.AppendAllText(Path.Combine(Config, "fixture-" + Pid + ".jsonl"), Json.Serialize(entry) + "\n", Utf8); }
    static void Send(object frame) { Console.WriteLine(Json.Serialize(frame)); }
    static readonly bool TokenSet = !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("CLAUDE_CODE_OAUTH_TOKEN"));
    static readonly string[] RoutingCredentials = new[] { "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_FOUNDRY_API_KEY", "ANTHROPIC_FOUNDRY_AUTH_TOKEN" };
    static bool Nonempty(object value) { return value is string && !String.IsNullOrEmpty((string)value); }
    static bool HasRoutingCredentials(Dictionary<string, object> values) {
        foreach (var key in RoutingCredentials) { object value; if (values.TryGetValue(key, out value) && Nonempty(value)) return true; }
        foreach (var key in new[] { "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY" }) {
            object value; if (values.TryGetValue(key, out value) && Nonempty(value) && (string)value != "0") return true;
        }
        object baseUrl;
        return values.TryGetValue("ANTHROPIC_BASE_URL", out baseUrl) && Nonempty(baseUrl) && (string)baseUrl != "https://api.anthropic.com";
    }
    static bool EnvironmentHasRoutingCredentials() {
        var values = new Dictionary<string, object>();
        foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) values[(string)entry.Key] = entry.Value;
        return HasRoutingCredentials(values);
    }
    // Like the installed CLI, a host-provided CLAUDE_CODE_OAUTH_TOKEN counts as signed in without touching the shared file.
    static bool LoggedIn() { return TokenSet || File.Exists(Path.Combine(Config, "signed-in.fixture")); }
    public static int Main(string[] args) {
        if (String.IsNullOrEmpty(Config) || !File.Exists(Path.Combine(Config, "isolated.fixture"))) return 2;
        Console.InputEncoding = Utf8; Console.OutputEncoding = Utf8;
        var rawArgs = args;
        var logicalArgs = new List<string>();
        string settingsFile = null;
        var settingsEnvironment = new Dictionary<string, object>();
        for (int index = 0; index < rawArgs.Length; index++) {
            if (rawArgs[index] != "--settings") { logicalArgs.Add(rawArgs[index]); continue; }
            if (settingsFile != null || ++index >= rawArgs.Length || !Path.IsPathRooted(rawArgs[index]) || !File.Exists(rawArgs[index])) return 2;
            settingsFile = rawArgs[index];
            var settings = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsFile, Utf8));
            object settingsEnv;
            if (settings.TryGetValue("env", out settingsEnv)) settingsEnvironment = settingsEnv as Dictionary<string, object>;
            if (settingsEnvironment == null) return 2;
        }
        args = logicalArgs.ToArray();
        object oauth;
        var settingsInfo = new { path = settingsFile, existedAtLaunch = settingsFile != null && File.Exists(settingsFile),
            routingCredentials = HasRoutingCredentials(settingsEnvironment), oauthToken = settingsEnvironment.TryGetValue("CLAUDE_CODE_OAUTH_TOKEN", out oauth) && Nonempty(oauth),
            environmentKeys = new List<string>(settingsEnvironment.Keys).ToArray() };
        bool environmentRoutingCredentials = EnvironmentHasRoutingCredentials();
        Log(new { type = "spawn", pid = Pid, args = args, rawArgs = rawArgs, settings = settingsInfo, cwd = Cwd, configDirectory = Config, tokenSet = TokenSet, environmentRoutingCredentials = environmentRoutingCredentials });
        if (args.Length == 1 && args[0] == "setup-token") {
            File.WriteAllText(Path.Combine(Config, "setup-console.json"), Json.Serialize(new { args = args, rawArgs = rawArgs, settings = settingsInfo, pid = Pid, cwd = Cwd, tokenSet = TokenSet, environmentRoutingCredentials = environmentRoutingCredentials, stdin = IsConsole(-10), stdout = IsConsole(-11), stderr = IsConsole(-12) }), Utf8);
            Console.WriteLine("Claude setup-token console test fixture. No browser, credentials or model.");
            return 0;
        }
        if (args.Length == 2 && args[0] == "auth" && args[1] == "status") {
            Send(new { loggedIn = LoggedIn(), authMethod = "oauth_token", email = "fixture@example.invalid", subscriptionType = "fixture", apiProvider = "firstParty", accessToken = "fixture-secret-must-not-cross-ipc" });
            return LoggedIn() ? 0 : 1;
        }
        if (args.Length == 3 && args[0] == "auth" && args[1] == "login" && args[2] == "--claudeai") {
            File.WriteAllText(Path.Combine(Config, "console.json"), Json.Serialize(new { args = args, rawArgs = rawArgs, settings = settingsInfo, pid = Pid, cwd = Cwd, configDirectory = Config, tokenSet = TokenSet, environmentRoutingCredentials = environmentRoutingCredentials, stdin = IsConsole(-10), stdout = IsConsole(-11), stderr = IsConsole(-12) }), Utf8);
            Console.WriteLine("Claude authorization console test fixture. No browser, credentials or model.");
            var deadline = DateTime.UtcNow.AddSeconds(30);
            while (!File.Exists(Path.Combine(Config, "release.fixture")) && DateTime.UtcNow < deadline) Thread.Sleep(50);
            if (File.Exists(Path.Combine(Config, "release.fixture"))) File.WriteAllText(Path.Combine(Config, "signed-in.fixture"), "fixture only", Utf8);
            return 0;
        }
        if (args.Length == 0 || args[0] != "-p") return 2;
        string line;
        while ((line = Console.ReadLine()) != null) {
            var frame = Json.Deserialize<Dictionary<string, object>>(line);
            Log(frame);
            if ((string)frame["type"] != "control_request") return 2;
            var request = (Dictionary<string, object>)frame["request"];
            string subtype = (string)request["subtype"];
            object id = frame["request_id"];
            if (!LoggedIn()) {
                Send(new { type = "control_response", response = new { subtype = "error", request_id = id, error = "Fixture: login required before bootstrap." } });
                continue;
            }
            object result = new { };
            if (subtype == "initialize") result = new { models = new object[] { new { value = "fixture-claude", displayName = "Fixture Claude", supportedEffortLevels = new[] { "medium" } } }, account = new { email = "fixture@example.invalid", subscriptionType = "fixture" }, current_permission_mode = "default" };
            else if (subtype == "get_settings") result = new { applied = new { model = "fixture-claude", effort = "medium" } };
            else if (subtype == "get_binary_version") result = new { version = "2.1.278-fixture" };
            else if (subtype == "mcp_status") result = new { mcpServers = new object[0] };
            Send(new { type = "control_response", response = new { subtype = "success", request_id = id, response = result } });
        }
        return 0;
    }
}
