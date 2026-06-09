using System.Diagnostics;

static string FindNode()
{
    var candidates = new[]
    {
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
    };

    foreach (var candidate in candidates)
    {
        if (File.Exists(candidate)) return candidate;
    }

    var path = Environment.GetEnvironmentVariable("PATH") ?? "";
    foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
    {
        var candidate = Path.Combine(dir.Trim(), "node.exe");
        if (File.Exists(candidate)) return candidate;
    }

    return "";
}

static int Run()
{
    Console.OutputEncoding = System.Text.Encoding.UTF8;
    Console.InputEncoding = System.Text.Encoding.UTF8;

    var appDir = AppContext.BaseDirectory;
    var monitorPath = Path.Combine(appDir, "monitor.js");
    if (!File.Exists(monitorPath))
    {
        Console.WriteLine("monitor.js 파일을 찾지 못했습니다.");
        Console.WriteLine("start_monitor.exe와 monitor.js가 같은 폴더에 있어야 합니다.");
        Console.WriteLine("아무 키나 누르면 종료합니다.");
        Console.ReadKey(true);
        return 1;
    }

    var nodePath = FindNode();
    if (string.IsNullOrWhiteSpace(nodePath))
    {
        Console.WriteLine("Node.js를 찾지 못했습니다.");
        Console.WriteLine("Node.js LTS를 설치한 뒤 다시 실행해 주세요.");
        Console.WriteLine("다운로드: https://nodejs.org/");
        Console.WriteLine("아무 키나 누르면 종료합니다.");
        Console.ReadKey(true);
        return 1;
    }

    var args = Environment.GetCommandLineArgs().Skip(1).ToArray();
    var argumentList = new List<string> { monitorPath };
    argumentList.AddRange(args);

    var process = new Process
    {
        StartInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            WorkingDirectory = appDir,
            UseShellExecute = false
        }
    };

    foreach (var arg in argumentList)
    {
        process.StartInfo.ArgumentList.Add(arg);
    }

    process.Start();
    process.WaitForExit();
    return process.ExitCode;
}

return Run();
