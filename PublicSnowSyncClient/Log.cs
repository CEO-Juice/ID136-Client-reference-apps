namespace PublicSnowSyncClient;

// Minimal console logging. Redirect output to a file from your scheduler if you want to keep it.
// PRODUCTION NOTE: use a real logging library (Microsoft.Extensions.Logging, Serilog, NLog) with log files
// that rotate, and alert on errors. Never log the settings object or request headers: they hold secrets.
public static class Log
{
    public static void Info(string message) => Write("INFO ", message);
    public static void Warn(string message) => Write("WARN ", message);
    public static void Error(string message) => Write("ERROR", message);

    private static void Write(string level, string message) =>
        Console.WriteLine($"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {level} {message}");
}
