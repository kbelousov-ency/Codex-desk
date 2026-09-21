using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// Isolated setup fixture. Never opens a browser, reads credentials or sends network requests.
public class SetupCliFixture {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    public static int Main(string[] args) {
        string root = Environment.GetEnvironmentVariable("SETUP_FIXTURE_ROOT");
        if (String.IsNullOrEmpty(root) || !File.Exists(Path.Combine(root, "isolated.fixture"))) return 2;
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        string provider = Path.GetFileNameWithoutExtension(Environment.GetCommandLineArgs()[0]).ToLowerInvariant();
        File.AppendAllText(Path.Combine(root, "calls.jsonl"), Json.Serialize(new { provider = provider, args = args }) + "\n");
        if (args.Length == 1 && args[0] == "--version") {
            Console.WriteLine(provider == "claude" ? "2.1.278 (Claude Code)" : "codex-cli 0.154.0"); return 0;
        }
        if (args.Length == 2 && args[0] == "auth" && args[1] == "status") {
            bool signed = File.Exists(Path.Combine(root, "signed-in.fixture"));
            Console.WriteLine(Json.Serialize(new { loggedIn = signed, email = "fixture@example.test", privateToken = "SECRET_FIXTURE" }));
            return signed ? 0 : 1;
        }
        if (args.Length == 3 && args[0] == "auth" && args[1] == "login") {
            File.WriteAllText(Path.Combine(root, "signed-in.fixture"), "fixture"); return 0;
        }
        if (args.Length > 0 && args[0] == "app-server") {
            string line;
            while ((line = Console.ReadLine()) != null) {
                var frame = Json.Deserialize<Dictionary<string, object>>(line);
                if (!frame.ContainsKey("id")) continue;
                string method = (string)frame["method"];
                File.AppendAllText(Path.Combine(root, "rpc.jsonl"), method + "\n");
                object result;
                if (method == "initialize") result = new { userAgent = "codex_cli_rs/0.154.0" };
                else if (method == "account/read") result = new { account = (object)null, requiresOpenaiAuth = false };
                else return 3;
                Console.WriteLine(Json.Serialize(new { id = frame["id"], result = result }));
            }
            return 0;
        }
        return 2;
    }
}
