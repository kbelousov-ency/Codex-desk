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
    // Like the installed CLI, a host-provided CLAUDE_CODE_OAUTH_TOKEN counts as signed in without touching the shared file.
    static bool LoggedIn() { return TokenSet || File.Exists(Path.Combine(Config, "signed-in.fixture")); }
    public static int Main(string[] args) {
        if (String.IsNullOrEmpty(Config) || !File.Exists(Path.Combine(Config, "isolated.fixture"))) return 2;
        Console.InputEncoding = Utf8; Console.OutputEncoding = Utf8;
        Log(new { type = "spawn", pid = Pid, args = args, cwd = Cwd, configDirectory = Config, tokenSet = TokenSet });
        if (args.Length == 1 && args[0] == "setup-token") {
            File.WriteAllText(Path.Combine(Config, "setup-console.json"), Json.Serialize(new { args = args, pid = Pid, cwd = Cwd, tokenSet = TokenSet, stdin = IsConsole(-10), stdout = IsConsole(-11), stderr = IsConsole(-12) }), Utf8);
            Console.WriteLine("Claude setup-token console test fixture. No browser, credentials or model.");
            return 0;
        }
        if (args.Length == 2 && args[0] == "auth" && args[1] == "status") {
            Send(new { loggedIn = LoggedIn(), authMethod = "oauth_token", email = "fixture@example.invalid", subscriptionType = "fixture", apiProvider = "firstParty", accessToken = "fixture-secret-must-not-cross-ipc" });
            return LoggedIn() ? 0 : 1;
        }
        if (args.Length == 3 && args[0] == "auth" && args[1] == "login" && args[2] == "--claudeai") {
            File.WriteAllText(Path.Combine(Config, "console.json"), Json.Serialize(new { args = args, pid = Pid, cwd = Cwd, configDirectory = Config, stdin = IsConsole(-10), stdout = IsConsole(-11), stderr = IsConsole(-12) }), Utf8);
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
