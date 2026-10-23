using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;

// Secure named-pipe host for Island HUD.
//
// Usage: pipe-host.exe <pipeName> <tcpPort> <parentPid>
//
// Creates a named pipe with an explicit DACL (current user + SYSTEM +
// Administrators), accepts clients, and proxies bytes to the Node bridge
// server on 127.0.0.1:<tcpPort>. Exits when the parent process dies.
internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Length < 3)
        {
            Console.Error.WriteLine("usage: pipe-host.exe <pipeName> <tcpPort> <parentPid>");
            return 2;
        }
        string pipeName = args[0];
        int port = int.Parse(args[1]);
        int parentPid = int.Parse(args[2]);

        var security = new PipeSecurity();
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        security.AddAccessRule(new PipeAccessRule(user, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));

        Console.WriteLine("ACL " + security.GetSecurityDescriptorSddlForm(AccessControlSections.Access));
        Console.WriteLine("READY");
        Console.Out.Flush();

        var parentWatch = new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(1000);
                try
                {
                    using (Process parent = Process.GetProcessById(parentPid))
                    {
                        parent.WaitForExit();
                    }
                    Environment.Exit(0);
                }
                catch
                {
                    Environment.Exit(0);
                }
            }
        });
        parentWatch.IsBackground = true;
        parentWatch.Start();

        while (true)
        {
            NamedPipeServerStream pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.WriteThrough,
                    65536,
                    65536,
                    security);
                pipe.WaitForConnection();
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("pipe-host accept failed: " + e.Message);
                if (pipe != null) pipe.Dispose();
                Thread.Sleep(500);
                continue;
            }

            TcpClient tcp = null;
            try
            {
                tcp = new TcpClient();
                tcp.NoDelay = true;
                tcp.Connect("127.0.0.1", port);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("pipe-host tcp connect failed: " + e.Message);
                try { pipe.Dispose(); } catch { }
                if (tcp != null) tcp.Dispose();
                Thread.Sleep(200);
                continue;
            }

            var p = pipe;
            var t = tcp;
            Task.Run(async () => await Proxy(p, t));
        }
    }

    private static async Task Proxy(NamedPipeServerStream pipe, TcpClient tcp)
    {
        try
        {
            using (pipe)
            using (tcp)
            {
                Stream ns = pipe;
                Stream ts = tcp.GetStream();
                Task a = Pump(ns, ts);
                Task b = Pump(ts, ns);
                await Task.WhenAny(a, b);
                // A closed direction must release the other outstanding read too.
                pipe.Dispose();
                tcp.Close();
                await Task.WhenAll(a, b);
            }
        }
        catch
        {
            // client disconnect
        }
    }

    private static async Task Pump(Stream from, Stream to)
    {
        var buffer = new byte[4096];
        try
        {
            int n;
            while ((n = await from.ReadAsync(buffer, 0, buffer.Length)) > 0)
            {
                await to.WriteAsync(buffer, 0, n);
                await to.FlushAsync();
            }
        }
        catch
        {
            // ignored
        }
    }
}
