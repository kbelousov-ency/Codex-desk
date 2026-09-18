using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Harmless native console fixture: JSONL App Server or a brief resume console.
// It does not invoke Codex, run commands, or access any provider/user history.
public class TerminalServerFixture {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly string ThreadId = "01965001-a55b-71da-bf8f-e23a3337ad7f";
    static readonly string Cwd = Directory.GetCurrentDirectory();
    static readonly int Pid = Process.GetCurrentProcess().Id;
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    static bool IsConsole(int id) { uint mode; return GetConsoleMode(GetStdHandle(id), out mode); }
    static void Log(object entry) { File.AppendAllText(Path.Combine(Cwd, "server-" + Pid + ".jsonl"), Json.Serialize(entry) + "\n", new UTF8Encoding(false)); }
    static void Reply(object id, object result) { Console.WriteLine(Json.Serialize(new { id = id, result = result })); }
    static object ThreadSnapshot() {
        var turns = new List<object>();
        turns.Add(new { id = "initial-turn", status = "completed", items = new object[] {
            new { id = "initial-user", type = "userMessage", content = new object[] { new { type = "text", text = "Fixture conversation", text_elements = new object[0] } } },
            new { id = "initial-answer", type = "agentMessage", phase = "final_answer", text = "History before terminal." }
        } });
        if (File.Exists(Path.Combine(Cwd, "terminal.done"))) turns.Add(new { id = "terminal-turn", status = "completed", items = new object[] {
            new { id = "terminal-answer", type = "agentMessage", phase = "final_answer", text = "History updated by terminal fixture." }
        } });
        return new { id = ThreadId, name = "Terminal fixture history", cwd = Cwd, historyMode = "legacy", status = new { type = "idle" }, turns = turns };
    }
    public static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length > 0 && args[0] == "resume") {
            File.WriteAllText(Path.Combine(Cwd, "terminal.json"), Json.Serialize(new { args = args, cwd = Cwd, pid = Pid, stdin = IsConsole(-10), stdout = IsConsole(-11), stderr = IsConsole(-12) }), new UTF8Encoding(false));
            Console.WriteLine("Codex Desk terminal regression fixture. No Codex/model requests.");
            Thread.Sleep(2200);
            File.WriteAllText(Path.Combine(Cwd, "terminal.done"), "complete", new UTF8Encoding(false));
            return 0;
        }
        if (args.Length == 0 || args[0] != "app-server") return 2;
        Log(new { type = "spawn", pid = Pid, args = args, cwd = Cwd });
        string line;
        while ((line = Console.ReadLine()) != null) {
            var request = Json.Deserialize<Dictionary<string, object>>(line);
            object methodValue;
            if (!request.TryGetValue("method", out methodValue)) continue;
            string method = (string)methodValue;
            Log(request);
            if (method == "initialized") continue;
            object id = request["id"];
            if (method == "initialize") Reply(id, new { userAgent = "Terminal fixture" });
            else if (method == "model/list") Reply(id, new { data = new object[] { new { id = "fixture-alpha", model = "fixture-alpha", displayName = "fixture-alpha", inputModalities = new [] { "text", "image" }, defaultReasoningEffort = "high", supportedReasoningEfforts = new object[] { new { reasoningEffort = "high" } } } }, nextCursor = (object)null });
            else if (method == "account/read") Reply(id, new { account = (object)null, requiresOpenaiAuth = false });
            else if (method == "config/read") Reply(id, new { config = new { model = "fixture-alpha", model_reasoning_effort = "high" } });
            else if (method == "thread/list") Reply(id, new { data = new object[] { ThreadSnapshot() }, nextCursor = (object)null });
            else if (method == "thread/read") Reply(id, new { thread = ThreadSnapshot() });
            else if (method == "thread/resume" || method == "thread/start") Reply(id, new { thread = ThreadSnapshot(), model = "fixture-alpha", reasoningEffort = "high" });
            else Console.WriteLine(Json.Serialize(new { id = id, error = new { code = -32601, message = "Unexpected fixture method: " + method } }));
        }
        return 0;
    }
}
