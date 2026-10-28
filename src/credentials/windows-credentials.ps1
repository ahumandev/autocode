param([switch] $AutoCodeInternalTrace)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$traceStartTicks = 0L
if ($AutoCodeInternalTrace) { $traceStartTicks = [Diagnostics.Stopwatch]::GetTimestamp() }

try {
    & {
        $source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// Same-token processes and administrators remain trusted; these protections cannot isolate either.
public static class AutoCodeWindowsCredentials
{
    private const int ProtocolLimit = 8388608;
    private const int CredentialLimit = 2560;
    private const int FileLimit = 1048576;
    private const int PathLimit = 259;
    private const int TargetLimit = 32767;
    private const int BufferSize = 4096;
    private const string TempPrefix = ".autocode-";
    private const string TempSuffix = ".tmp";
    private const uint GenericCredential = 1;
    private const uint LocalMachinePersistence = 2;
    private const uint ReadControl = 0x00020000;
    private const uint ReadAttributes = 0x00000080;
    private const uint GenericRead = 0x80000000;
    private const uint ShareRead = 0x00000001;
    private const uint OpenExisting = 3;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint BackupSemantics = 0x02000000;
    private const uint AttributeDirectory = 0x00000010;
    private const uint AttributeDevice = 0x00000040;
    private const uint AttributeReparsePoint = 0x00000400;
    private const uint DiskFile = 1;
    private const uint FileObject = 1;
    private const uint VolumeNameGuid = 1;
    private const uint OwnerAndDacl = 0x00000005;
    private const uint ReplaceExisting = 0x00000001;
    private const uint WriteThrough = 0x00000008;
    private const int ErrorFileNotFound = 2;
    private const int ErrorPathNotFound = 3;
    private const int ErrorAlreadyExists = 183;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static bool traceEnabled;
    private static long traceStartTicks;
    private static int traceInputBytes;
    private static int traceRecords;
    private static Dictionary<string, int> traceCounts;
    private static readonly Regex TargetPattern = new Regex(
        @"\AAutoCode/v1/(ssh|db|rest)/[A-Z0-9_]+\z", RegexOptions.CultureInvariant);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeCredential
    {
        public uint Flags;
        public uint Type;
        public IntPtr TargetName;
        public IntPtr Comment;
        public uint LastWrittenLow;
        public uint LastWrittenHigh;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public IntPtr TargetAlias;
        public IntPtr UserName;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HandleInformation
    {
        public uint FileAttributes;
        public uint CreationTimeLow;
        public uint CreationTimeHigh;
        public uint LastAccessTimeLow;
        public uint LastAccessTimeHigh;
        public uint LastWriteTimeLow;
        public uint LastWriteTimeHigh;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;

        public ulong Size
        {
            get { return ((ulong)FileSizeHigh << 32) | FileSizeLow; }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr SecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)]
        public bool InheritHandle;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredWrite(ref NativeCredential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern void CredFree(IntPtr credential);

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out HandleInformation information);

    [DllImport("kernel32.dll", ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFileType(SafeFileHandle handle);

    [DllImport("kernel32.dll", EntryPoint = "GetDriveTypeW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern uint GetDriveType(string root);

    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint capacity, uint flags);

    [DllImport("kernel32.dll", EntryPoint = "CreateDirectoryW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateDirectory(string path, ref SecurityAttributes security);

    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string source, string destination, uint flags);

    [DllImport("kernel32.dll", EntryPoint = "DeleteFileW", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteFile(string path);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityInfo(SafeFileHandle handle, uint objectType, uint securityInformation,
        out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr securityDescriptor);

    [DllImport("advapi32.dll", ExactSpelling = true)]
    private static extern uint GetSecurityDescriptorLength(IntPtr securityDescriptor);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr LocalFree(IntPtr memory);

    private sealed class Failure : Exception
    {
        public readonly string Status;
        public readonly string Code;
        public readonly int? NativeCode;

        public Failure(string code) : base("Credential operation failed.")
        {
            Status = "error";
            Code = code;
        }

        public Failure(string status, string code, int? nativeCode) : base("Credential operation failed.")
        {
            Status = status;
            Code = code;
            NativeCode = nativeCode;
        }
    }

    private sealed class PathPlan
    {
        public string FullPath;
        public string Root;
        public string Parent;
        public string[] Components;
    }

    private sealed class PinnedDirectory : IDisposable
    {
        public readonly SafeFileHandle Handle;
        public readonly bool Strict;

        public PinnedDirectory(SafeFileHandle handle, bool strict)
        {
            Handle = handle;
            Strict = strict;
        }

        public void Dispose()
        {
            Handle.Dispose();
        }
    }

    private sealed class PinnedPath : IDisposable
    {
        public readonly List<PinnedDirectory> Directories = new List<PinnedDirectory>();

        public void Verify(SecurityIdentifier sid)
        {
            foreach (PinnedDirectory directory in Directories)
                VerifyDirectory(directory.Handle, directory.Strict, sid);
        }

        public void Dispose()
        {
            for (int i = Directories.Count - 1; i >= 0; i--)
                Directories[i].Dispose();
        }
    }

    private static void Trace(string stage)
    {
        if (!traceEnabled)
            return;
        try
        {
            int count;
            traceCounts.TryGetValue(stage, out count);
            // Repeated parent stages leave room for response and cleanup receipts within the 96-record cap.
            if (count >= 16 || traceRecords >= 96)
                return;
            traceCounts[stage] = count + 1;
            traceRecords++;
            long elapsed = (long)((Stopwatch.GetTimestamp() - traceStartTicks) * 1000.0 / Stopwatch.Frequency);
            Console.Error.Write("ACW_INTERNAL_STAGE_V1|" + stage + "|" + elapsed.ToString(CultureInfo.InvariantCulture) +
                "|" + traceInputBytes.ToString(CultureInfo.InvariantCulture) + "\n");
            Console.Error.Flush();
        }
        catch
        {
            traceEnabled = false;
        }
    }

    public static void Run(bool internalTrace, long startTicks)
    {
        traceEnabled = internalTrace;
        if (traceEnabled)
        {
            traceStartTicks = startTicks;
            traceRecords = 2;
            traceCounts = new Dictionary<string, int>(StringComparer.Ordinal);
        }
        Dictionary<string, object> response;
        bool fileOperation = false;
        try
        {
            string input = ReadFrame();
            Trace("parse-before");
            Dictionary<string, object> request = new RequestParser(input).Parse();
            string operation = ValidateRequest(request);
            Trace("parse-after");
            fileOperation = operation == "file-read" || operation == "file-write";
            // GetCurrent uses the effective thread/process token, never the interactive desktop account.
            Trace("tokenSID-before");
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                SecurityIdentifier sid = identity.User;
                if (sid == null)
                    throw new Failure("unavailable", null, null);
                AssertSid(request, sid);
                Trace("tokenSID-after");
                Trace("dispatch-before");
                response = Dispatch(request, operation, identity, sid);
                Trace("dispatch-after");
            }
        }
        catch (Failure failure)
        {
            response = FailureResponse(failure);
        }
        catch (DecoderFallbackException)
        {
            response = FailureResponse(new Failure("invalid"));
        }
        catch (EncoderFallbackException)
        {
            response = FailureResponse(new Failure("invalid"));
        }
        catch (Exception exception)
        {
            response = FailureResponse(NativeFailure(exception.HResult & 0xffff, fileOperation));
        }

        Trace("response-before");
        byte[] output;
        try
        {
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = ProtocolLimit;
            serializer.RecursionLimit = 8;
            string frame = serializer.Serialize(response) + "\n";
            if (Utf8.GetByteCount(frame) > ProtocolLimit)
                throw new Failure("too_large");
            output = Utf8.GetBytes(frame);
        }
        catch
        {
            output = Utf8.GetBytes("{\"version\":1,\"status\":\"error\",\"code\":\"failed\"}\n");
        }

        try
        {
            using (Stream stdout = Console.OpenStandardOutput())
            {
                stdout.Write(output, 0, output.Length);
                stdout.Flush();
            }
            Trace("response-after");
        }
        catch
        {
            // A broken output pipe must not append a second response or expose an exception.
        }
        finally
        {
            Trace("cleanup-before");
            Array.Clear(output, 0, output.Length);
            Trace("cleanup-after");
        }
    }

    private static string ReadFrame()
    {
        Trace("input-before");
        byte[] bytes = new byte[ProtocolLimit + 1];
        try
        {
            int length = 0;
            bool newlineSeen = false;
            bool eofAwaitTraced = false;
            using (Stream stdin = Console.OpenStandardInput())
            {
                while (length < bytes.Length)
                {
                    if (traceEnabled && newlineSeen && !eofAwaitTraced)
                    {
                        Trace("input-await-EOF");
                        eofAwaitTraced = true;
                    }
                    int count = stdin.Read(bytes, length, Math.Min(BufferSize, bytes.Length - length));
                    if (count == 0)
                        break;
                    if (traceEnabled)
                    {
                        traceInputBytes = length + count;
                        if (!newlineSeen)
                        {
                            for (int i = length; i < length + count; i++)
                            {
                                if (bytes[i] != 10)
                                    continue;
                                newlineSeen = true;
                                Trace("input-newline");
                                break;
                            }
                        }
                    }
                    length += count;
                }
            }
            if (length > ProtocolLimit)
                throw new Failure("too_large");
            if (length == 0)
                throw new Failure("invalid");
            string frame = Utf8.GetString(bytes, 0, length);
            if (frame.EndsWith("\n", StringComparison.Ordinal))
            {
                frame = frame.Substring(0, frame.Length - 1);
                if (frame.EndsWith("\r", StringComparison.Ordinal))
                    frame = frame.Substring(0, frame.Length - 1);
            }
            if (frame.IndexOf('\n') >= 0 || frame.IndexOf('\r') >= 0)
                throw new Failure("invalid");
            Trace("input-after");
            return frame;
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
        }
    }

    private static string ValidateRequest(Dictionary<string, object> request)
    {
        object version;
        if (!request.TryGetValue("version", out version) || !(version is int) || (int)version != 1)
            throw new Failure("invalid");
        string operation = RequiredString(request, "operation");
        bool native = operation == "read" || operation == "write" || operation == "delete";
        bool enumerate = operation == "enumerate";
        bool file = operation == "file-read" || operation == "file-write";
        if (!native && !enumerate && !file && operation != "identity")
            throw new Failure("invalid");
        foreach (KeyValuePair<string, object> field in request)
        {
            bool allowed = field.Key == "version" || field.Key == "operation" || field.Key == "expectedSid" ||
                (native && field.Key == "target") ||
                (enumerate && field.Key == "kind") ||
                (file && (field.Key == "path" || field.Key == "maxBytes")) ||
                ((operation == "write" || operation == "file-write") && field.Key == "payload");
            if (!allowed)
                throw new Failure("invalid");
            if (field.Key == "maxBytes")
            {
                if (!(field.Value is int) || (int)field.Value < 1 || (int)field.Value > FileLimit)
                    throw new Failure("invalid");
            }
            else if (field.Key != "version" && !(field.Value is string))
            {
                throw new Failure("invalid");
            }
        }
        if (native)
        {
            string target = RequiredString(request, "target");
            if (target.Length > TargetLimit || !TargetPattern.IsMatch(target))
                throw new Failure("invalid");
        }
        if (enumerate)
        {
            string kind = RequiredString(request, "kind");
            if (kind != "ssh" && kind != "db" && kind != "rest")
                throw new Failure("invalid");
        }
        if (file)
            RequiredString(request, "path");
        if (operation == "write" || operation == "file-write")
            RequiredString(request, "payload");
        return operation;
    }

    private static string RequiredString(Dictionary<string, object> request, string name)
    {
        object value;
        if (!request.TryGetValue(name, out value) || !(value is string))
            throw new Failure("invalid");
        return (string)value;
    }

    private static void AssertSid(Dictionary<string, object> request, SecurityIdentifier current)
    {
        if (!request.ContainsKey("expectedSid"))
            return;
        SecurityIdentifier expected;
        try
        {
            expected = new SecurityIdentifier(RequiredString(request, "expectedSid"));
        }
        catch (ArgumentException)
        {
            throw new Failure("invalid");
        }
        // The optional assertion precedes every native/filesystem read, create, write, and delete.
        if (!current.Equals(expected))
            throw new Failure("denied");
    }

    private static Dictionary<string, object> Dispatch(Dictionary<string, object> request, string operation,
        WindowsIdentity identity, SecurityIdentifier sid)
    {
        if (operation == "identity")
        {
            Dictionary<string, object> result = Ok();
            Dictionary<string, object> token = new Dictionary<string, object>();
            token.Add("sid", sid.Value);
            Trace("identityName-before");
            token.Add("account", identity.Name);
            Trace("identityName-after");
            result.Add("identity", token);
            return result;
        }
        if (operation == "read")
            return WithPayload(ReadCredential((string)request["target"]));
        if (operation == "write")
        {
            WriteCredential((string)request["target"], (string)request["payload"]);
            return Ok();
        }
        if (operation == "delete")
        {
            if (!CredDelete((string)request["target"], GenericCredential, 0))
                throw NativeFailure(Marshal.GetLastWin32Error(), false);
            return Ok();
        }
        if (operation == "enumerate")
            return WithIds(EnumerateCredentialIds((string)request["kind"]));
        // Omitting maxBytes selects the hard file cap; supplying it can only lower that cap.
        int maxBytes = request.ContainsKey("maxBytes") ? (int)request["maxBytes"] : FileLimit;
        PathPlan path = ValidatePath((string)request["path"]);
        if (operation == "file-read")
            return WithPayload(ReadProtectedFile(path, maxBytes, sid));
        WriteProtectedFile(path, (string)request["payload"], maxBytes, sid);
        return Ok();
    }

    private static string ReadCredential(string target)
    {
        IntPtr pointer = IntPtr.Zero;
        byte[] bytes = null;
        try
        {
            if (!CredRead(target, GenericCredential, 0, out pointer))
                throw NativeFailure(Marshal.GetLastWin32Error(), false);
            if (pointer == IntPtr.Zero)
                throw new Failure("invalid");
            NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(pointer, typeof(NativeCredential));
            if (credential.CredentialBlobSize > CredentialLimit)
                throw new Failure("too_large");
            if (credential.Type != GenericCredential ||
                (credential.CredentialBlobSize != 0 && credential.CredentialBlob == IntPtr.Zero))
                throw new Failure("invalid");
            bytes = new byte[(int)credential.CredentialBlobSize];
            if (bytes.Length != 0)
                Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return Utf8.GetString(bytes);
        }
        finally
        {
            if (bytes != null)
                Array.Clear(bytes, 0, bytes.Length);
            if (pointer != IntPtr.Zero)
                CredFree(pointer);
        }
    }

    private static string[] EnumerateCredentialIds(string kind)
    {
        const int MaximumCredentials = 4096;
        string prefix = "AutoCode/v1/" + kind + "/";
        IntPtr credentials = IntPtr.Zero;
        uint count = 0;
        try
        {
            if (!CredEnumerate(prefix + "*", 0, out count, out credentials))
            {
                int error = Marshal.GetLastWin32Error();
                if (error == 1168)
                    return new string[0];
                throw NativeFailure(error, false);
            }
            if (count > MaximumCredentials || (count != 0 && credentials == IntPtr.Zero))
                throw new Failure("too_large");
            if (count == 0)
                return new string[0];

            List<string> ids = new List<string>();
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            int totalBytes = 0;
            for (int index = 0; index < (int)count; index++)
            {
                IntPtr credentialPointer = Marshal.ReadIntPtr(credentials, index * IntPtr.Size);
                if (credentialPointer == IntPtr.Zero)
                    throw new Failure("invalid");
                NativeCredential credential = (NativeCredential)Marshal.PtrToStructure(credentialPointer, typeof(NativeCredential));
                if (credential.Type != GenericCredential || credential.TargetName == IntPtr.Zero)
                    continue;
                string target = Marshal.PtrToStringUni(credential.TargetName);
                if (target == null || !target.StartsWith(prefix, StringComparison.Ordinal))
                    continue;
                string id = target.Substring(prefix.Length);
                if (!Regex.IsMatch(id, @"\A[A-Z0-9_]+\z", RegexOptions.CultureInvariant) || !seen.Add(id))
                    continue;
                totalBytes += Utf8.GetByteCount(id) + 8;
                if (totalBytes > ProtocolLimit - 4096)
                    throw new Failure("too_large");
                ids.Add(id);
            }
            return ids.ToArray();
        }
        finally
        {
            if (credentials != IntPtr.Zero)
                CredFree(credentials);
        }
    }

    private static void WriteCredential(string target, string payload)
    {
        if (Utf8.GetByteCount(payload) > CredentialLimit)
            throw new Failure("too_large");
        byte[] bytes = Utf8.GetBytes(payload);
        IntPtr targetPointer = IntPtr.Zero;
        IntPtr blob = IntPtr.Zero;
        try
        {
            targetPointer = Marshal.StringToHGlobalUni(target);
            if (bytes.Length != 0)
            {
                blob = Marshal.AllocHGlobal(bytes.Length);
                Marshal.Copy(bytes, 0, blob, bytes.Length);
            }
            NativeCredential credential = new NativeCredential();
            credential.Type = GenericCredential;
            credential.TargetName = targetPointer;
            credential.CredentialBlobSize = (uint)bytes.Length;
            credential.CredentialBlob = blob;
            // Persistence 2 survives logoff on this machine but remains scoped to the effective user's credential set.
            credential.Persist = LocalMachinePersistence;
            if (!CredWrite(ref credential, 0))
                throw NativeFailure(Marshal.GetLastWin32Error(), false);
        }
        finally
        {
            if (blob != IntPtr.Zero)
            {
                for (int i = 0; i < bytes.Length; i++)
                    Marshal.WriteByte(blob, i, 0);
                Marshal.FreeHGlobal(blob);
            }
            if (targetPointer != IntPtr.Zero)
                Marshal.FreeHGlobal(targetPointer);
            Array.Clear(bytes, 0, bytes.Length);
        }
    }

    private static PathPlan ValidatePath(string supplied)
    {
        // The trusted caller chooses the credential location; project files/configuration never choose it here.
        if (supplied.Length < 4 || supplied.Length > PathLimit ||
            !((supplied[0] >= 'A' && supplied[0] <= 'Z') || (supplied[0] >= 'a' && supplied[0] <= 'z')) ||
            supplied[1] != ':' || supplied[2] != '\\' || supplied.IndexOf('/') >= 0)
            throw new Failure("invalid");
        string[] components = supplied.Substring(3).Split('\\');
        if (components.Length < 2)
            throw new Failure("invalid");
        foreach (string component in components)
            ValidateComponent(component);
        string canonical;
        try
        {
            canonical = Path.GetFullPath(supplied);
        }
        catch (ArgumentException)
        {
            throw new Failure("invalid");
        }
        catch (NotSupportedException)
        {
            throw new Failure("invalid");
        }
        catch (PathTooLongException)
        {
            throw new Failure("invalid");
        }
        if (canonical.Length > PathLimit || !string.Equals(canonical, supplied, StringComparison.OrdinalIgnoreCase))
            throw new Failure("invalid");
        string root = canonical.Substring(0, 3);
        DriveType drive = (DriveType)GetDriveType(root);
        if (drive == DriveType.NoRootDirectory)
            throw new Failure("missing", null, null);
        if (drive != DriveType.Removable && drive != DriveType.Fixed && drive != DriveType.CDRom && drive != DriveType.Ram)
            throw new Failure("denied");
        PathPlan plan = new PathPlan();
        plan.FullPath = canonical;
        plan.Root = root;
        plan.Parent = Path.GetDirectoryName(canonical);
        plan.Components = canonical.Substring(3).Split('\\');
        return plan;
    }

    private static void ValidateComponent(string component)
    {
        if (component.Length == 0 || component.Length > 255 || component == "." || component == ".." ||
            component[component.Length - 1] == '.' || component[component.Length - 1] == ' ')
            throw new Failure("invalid");
        foreach (char character in component)
        {
            if (character < 32 || "<>:\"/\\|?*".IndexOf(character) >= 0)
                throw new Failure("invalid");
        }
        int dot = component.IndexOf('.');
        string stem = (dot < 0 ? component : component.Substring(0, dot)).TrimEnd(' ');
        stem = stem.ToUpperInvariant();
        if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" ||
            stem == "CLOCK$" || stem == "CONIN$" || stem == "CONOUT$")
            throw new Failure("invalid");
        if (stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)))
        {
            char number = stem[3];
            if ((number >= '1' && number <= '9') || number == '\u00b9' || number == '\u00b2' || number == '\u00b3')
                throw new Failure("invalid");
        }
    }

    private static PinnedPath PinParents(PathPlan path, bool create, SecurityIdentifier sid)
    {
        PinnedPath pinned = new PinnedPath();
        try
        {
            AddDirectory(pinned, OpenPath(path.Root, ReadAttributes), false, sid);
            VerifyVolumeRoot(pinned.Directories[0].Handle);
            string current = path.Root;
            for (int i = 0; i < path.Components.Length - 1; i++)
            {
                current = Path.Combine(current, path.Components[i]);
                bool strict = i == path.Components.Length - 2;
                SafeFileHandle handle = null;
                try
                {
                    handle = OpenPath(current, ReadAttributes | (strict ? ReadControl : 0));
                }
                catch (Failure failure)
                {
                    if (!create || failure.Status != "missing")
                        throw;
                    pinned.Verify(sid);
                    CreateProtectedDirectory(current, sid);
                    strict = true;
                    handle = OpenPath(current, ReadAttributes | ReadControl);
                }
                AddDirectory(pinned, handle, strict, sid);
            }
            pinned.Verify(sid);
            return pinned;
        }
        catch
        {
            pinned.Dispose();
            throw;
        }
    }

    private static void AddDirectory(PinnedPath pinned, SafeFileHandle handle, bool strict, SecurityIdentifier sid)
    {
        try
        {
            VerifyDirectory(handle, strict, sid);
            pinned.Directories.Add(new PinnedDirectory(handle, strict));
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static SafeFileHandle OpenPath(string path, uint access, bool file = false)
    {
        Trace(file ? "file-open-before" : "parent-open-before");
        // Denying write/delete sharing pins names and blocks new reparse-point writers throughout handle lifetime.
        SafeFileHandle handle = CreateFile(path, access, ShareRead, IntPtr.Zero, OpenExisting,
            OpenReparsePoint | BackupSemantics, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw NativeFailure(error, true);
        }
        Trace(file ? "file-open-after" : "parent-open-after");
        return handle;
    }

    private static void VerifyVolumeRoot(SafeFileHandle handle)
    {
        Trace("parent-verify-before");
        // A SUBST drive into a directory would otherwise hide unpinned ancestors behind its drive root.
        StringBuilder path = new StringBuilder(PathLimit + 1);
        uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, VolumeNameGuid);
        if (length == 0)
            throw NativeFailure(Marshal.GetLastWin32Error(), true);
        if (length >= path.Capacity)
            throw new Failure("denied");
        string name = path.ToString();
        const string prefix = @"\\?\Volume{";
        const int guidLength = 36;
        Guid volume;
        if (name.Length != prefix.Length + guidLength + 2 ||
            !name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ||
            !name.EndsWith(@"}\", StringComparison.Ordinal) ||
            !Guid.TryParse(name.Substring(prefix.Length, guidLength), out volume))
            throw new Failure("denied");
        Trace("parent-verify-after");
    }

    private static HandleInformation InspectHandle(SafeFileHandle handle, bool directory)
    {
        HandleInformation information;
        if (!GetFileInformationByHandle(handle, out information))
            throw NativeFailure(Marshal.GetLastWin32Error(), true);
        if ((information.FileAttributes & (AttributeReparsePoint | AttributeDevice)) != 0 ||
            ((information.FileAttributes & AttributeDirectory) != 0) != directory)
            throw new Failure("denied");
        uint type = GetFileType(handle);
        if (type == 0)
        {
            int error = Marshal.GetLastWin32Error();
            if (error != 0)
                throw NativeFailure(error, true);
        }
        if (type != DiskFile)
            throw new Failure("denied");
        return information;
    }

    private static void VerifyDirectory(SafeFileHandle handle, bool strict, SecurityIdentifier sid)
    {
        Trace("parent-verify-before");
        InspectHandle(handle, true);
        if (strict)
            VerifySecurity(handle, true, sid);
        Trace("parent-verify-after");
    }

    private static HandleInformation VerifyFile(SafeFileHandle handle, int maxBytes, SecurityIdentifier sid)
    {
        HandleInformation information = InspectHandle(handle, false);
        VerifySecurity(handle, false, sid);
        if (information.Size > (ulong)maxBytes)
            throw new Failure("too_large");
        return information;
    }

    private static void VerifySecurity(SafeFileHandle handle, bool directory, SecurityIdentifier sid)
    {
        IntPtr owner;
        IntPtr group;
        IntPtr dacl;
        IntPtr sacl;
        IntPtr descriptor = IntPtr.Zero;
        try
        {
            uint error = GetSecurityInfo(handle, FileObject, OwnerAndDacl, out owner, out group, out dacl, out sacl, out descriptor);
            if (error != 0)
                throw NativeFailure((int)error, true);
            if (descriptor == IntPtr.Zero || owner == IntPtr.Zero || dacl == IntPtr.Zero)
                throw new Failure("denied");
            uint length = GetSecurityDescriptorLength(descriptor);
            if (length < 20 || length > 65536)
                throw new Failure("denied");
            byte[] bytes = new byte[(int)length];
            Marshal.Copy(descriptor, bytes, 0, bytes.Length);
            RawSecurityDescriptor security;
            try
            {
                security = new RawSecurityDescriptor(bytes, 0);
            }
            catch (ArgumentException)
            {
                throw new Failure("denied");
            }
            ControlFlags required = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclProtected;
            if (security.Owner == null || !sid.Equals(security.Owner) ||
                (security.ControlFlags & required) != required ||
                security.DiscretionaryAcl == null || security.DiscretionaryAcl.Count != 1)
                throw new Failure("denied");
            CommonAce ace = security.DiscretionaryAcl[0] as CommonAce;
            if (ace == null || ace.AceType != AceType.AccessAllowed || ace.IsCallback || ace.OpaqueLength != 0 ||
                !sid.Equals(ace.SecurityIdentifier) || ace.AccessMask != (int)FileSystemRights.FullControl)
                throw new Failure("denied");
            AceFlags inheritance = AceFlags.ObjectInherit | AceFlags.ContainerInherit;
            if (ace.AceFlags != AceFlags.None && (!directory || ace.AceFlags != inheritance))
                throw new Failure("denied");
        }
        finally
        {
            if (descriptor != IntPtr.Zero)
                LocalFree(descriptor);
        }
    }

    private static DirectorySecurity OwnerDirectorySecurity(SecurityIdentifier sid)
    {
        DirectorySecurity security = new DirectorySecurity();
        security.SetOwner(sid);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        return security;
    }

    private static FileSecurity OwnerFileSecurity(SecurityIdentifier sid)
    {
        FileSecurity security = new FileSecurity();
        security.SetOwner(sid);
        security.SetAccessRuleProtection(true, false);
        security.AddAccessRule(new FileSystemAccessRule(sid, FileSystemRights.FullControl, AccessControlType.Allow));
        return security;
    }

    private static void CreateProtectedDirectory(string path, SecurityIdentifier sid)
    {
        byte[] descriptor = OwnerDirectorySecurity(sid).GetSecurityDescriptorBinaryForm();
        IntPtr memory = Marshal.AllocHGlobal(descriptor.Length);
        try
        {
            Marshal.Copy(descriptor, 0, memory, descriptor.Length);
            SecurityAttributes attributes = new SecurityAttributes();
            attributes.Length = Marshal.SizeOf(typeof(SecurityAttributes));
            attributes.SecurityDescriptor = memory;
            if (!CreateDirectory(path, ref attributes))
            {
                int error = Marshal.GetLastWin32Error();
                if (error != ErrorAlreadyExists)
                    throw NativeFailure(error, true);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(memory);
        }
    }

    private static string ReadProtectedFile(PathPlan path, int maxBytes, SecurityIdentifier sid)
    {
        using (PinnedPath pinned = PinParents(path, false, sid))
        using (SafeFileHandle handle = OpenPath(path.FullPath, GenericRead | ReadControl, true))
        {
            VerifyFile(handle, maxBytes, sid);
            pinned.Verify(sid);
            byte[] bytes = new byte[maxBytes + 1];
            try
            {
                int length = 0;
                Trace("file-read-before");
                // A one-byte stream buffer prevents read-ahead beyond the explicit maxBytes + 1 budget.
                using (FileStream stream = new FileStream(handle, FileAccess.Read, 1, false))
                {
                    while (length < bytes.Length)
                    {
                        int count = stream.Read(bytes, length, Math.Min(BufferSize, bytes.Length - length));
                        if (count == 0)
                            break;
                        length += count;
                    }
                    Trace("file-read-after");
                    if (length > maxBytes)
                        throw new Failure("too_large");
                    HandleInformation information = VerifyFile(handle, maxBytes, sid);
                    if (information.Size != (ulong)length)
                        throw new Failure("failed");
                    pinned.Verify(sid);
                    return Utf8.GetString(bytes, 0, length);
                }
            }
            finally
            {
                Array.Clear(bytes, 0, bytes.Length);
            }
        }
    }

    private static SafeFileHandle OpenDestination(PathPlan path, int maxBytes, SecurityIdentifier sid)
    {
        SafeFileHandle handle;
        try
        {
            handle = OpenPath(path.FullPath, ReadAttributes | ReadControl, true);
        }
        catch (Failure failure)
        {
            if (failure.Status == "missing")
                return null;
            throw;
        }
        try
        {
            VerifyFile(handle, maxBytes, sid);
            return handle;
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    private static void WriteProtectedFile(PathPlan path, string payload, int maxBytes, SecurityIdentifier sid)
    {
        int length = Utf8.GetByteCount(payload);
        if (length > maxBytes)
            throw new Failure("too_large");
        string temp = Path.Combine(path.Parent, TempPrefix + Guid.NewGuid().ToString("N") + TempSuffix);
        if (temp.Length > PathLimit || string.Equals(temp, path.FullPath, StringComparison.OrdinalIgnoreCase))
            throw new Failure("invalid");
        byte[] bytes = Utf8.GetBytes(payload);
        try
        {
            using (PinnedPath pinned = PinParents(path, true, sid))
            {
                SafeFileHandle destination = null;
                bool ownTemp = false;
                try
                {
                    destination = OpenDestination(path, maxBytes, sid);
                    pinned.Verify(sid);
                    HandleInformation written;
                    using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileSystemRights.FullControl,
                        FileShare.None, BufferSize, FileOptions.WriteThrough, OwnerFileSecurity(sid)))
                    {
                        ownTemp = true;
                        VerifyFile(stream.SafeFileHandle, maxBytes, sid);
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush(true);
                        written = VerifyFile(stream.SafeFileHandle, maxBytes, sid);
                        if (written.Size != (ulong)bytes.Length)
                            throw new Failure("failed");
                    }
                    pinned.Verify(sid);
                    if (destination != null)
                    {
                        VerifyFile(destination, maxBytes, sid);
                        destination.Dispose();
                        destination = null;
                    }
                    // Exclusive handles must close for rename; owner-only parents exclude other-token swaps in this window.
                    if (!MoveFileEx(temp, path.FullPath, ReplaceExisting | WriteThrough))
                        throw NativeFailure(Marshal.GetLastWin32Error(), true);
                    ownTemp = false;
                    using (SafeFileHandle committed = OpenPath(path.FullPath, ReadAttributes | ReadControl, true))
                    {
                        HandleInformation current = VerifyFile(committed, maxBytes, sid);
                        if (current.VolumeSerialNumber != written.VolumeSerialNumber ||
                            current.FileIndexHigh != written.FileIndexHigh || current.FileIndexLow != written.FileIndexLow ||
                            current.Size != written.Size)
                            throw new Failure("denied");
                        pinned.Verify(sid);
                    }
                }
                finally
                {
                    if (destination != null)
                        destination.Dispose();
                    // Cleanup is limited to this invocation's successfully created random temp, never a destination or directory.
                    if (ownTemp)
                        DeleteFile(temp);
                }
            }
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
        }
    }

    private static Failure NativeFailure(int nativeCode, bool fileOperation)
    {
        if (nativeCode == 1168 || (fileOperation && (nativeCode == ErrorFileNotFound || nativeCode == ErrorPathNotFound)))
            return new Failure("missing", null, nativeCode);
        if (nativeCode == 1312)
            return new Failure("unavailable", null, nativeCode);
        if (nativeCode == 5)
            return new Failure("error", "denied", nativeCode);
        if (nativeCode == 1909)
            return new Failure("error", "locked", nativeCode);
        if (nativeCode == 13)
            return new Failure("error", "invalid", nativeCode);
        return new Failure("error", "failed", nativeCode);
    }

    private static Dictionary<string, object> Ok()
    {
        Dictionary<string, object> response = new Dictionary<string, object>();
        response.Add("version", 1);
        response.Add("status", "ok");
        return response;
    }

    private static Dictionary<string, object> WithPayload(string payload)
    {
        Dictionary<string, object> response = Ok();
        response.Add("payload", payload);
        return response;
    }

    private static Dictionary<string, object> WithIds(string[] ids)
    {
        Dictionary<string, object> response = Ok();
        response.Add("ids", ids);
        return response;
    }

    private static Dictionary<string, object> FailureResponse(Failure failure)
    {
        Dictionary<string, object> response = new Dictionary<string, object>();
        response.Add("version", 1);
        response.Add("status", failure.Status);
        if (failure.Status == "error")
            response.Add("code", failure.Code);
        if (failure.NativeCode.HasValue)
            response.Add("nativeCode", failure.NativeCode.Value);
        return response;
    }

    // A flat schema parser rejects duplicate fields and noninteger values instead of coercing JavaScriptSerializer input.
    private sealed class RequestParser
    {
        private readonly string text;
        private int position;

        public RequestParser(string text)
        {
            this.text = text;
        }

        public Dictionary<string, object> Parse()
        {
            Dictionary<string, object> fields = new Dictionary<string, object>(StringComparer.Ordinal);
            Expect('{');
            SkipWhitespace();
            if (Take('}'))
                throw new Failure("invalid");
            while (true)
            {
                string key = ReadString();
                if (fields.ContainsKey(key) || fields.Count >= 7)
                    throw new Failure("invalid");
                Expect(':');
                SkipWhitespace();
                object value;
                if (position < text.Length && text[position] == '"')
                    value = ReadString();
                else
                    value = ReadInteger();
                fields.Add(key, value);
                SkipWhitespace();
                if (Take('}'))
                    break;
                Expect(',');
            }
            SkipWhitespace();
            if (position != text.Length)
                throw new Failure("invalid");
            return fields;
        }

        private string ReadString()
        {
            Expect('"');
            StringBuilder value = new StringBuilder();
            while (position < text.Length)
            {
                char character = text[position++];
                if (character == '"')
                {
                    string result = value.ToString();
                    Utf8.GetByteCount(result);
                    return result;
                }
                if (character < 32)
                    throw new Failure("invalid");
                if (character != '\\')
                {
                    value.Append(character);
                    continue;
                }
                if (position == text.Length)
                    throw new Failure("invalid");
                char escape = text[position++];
                switch (escape)
                {
                    case '"': value.Append('"'); break;
                    case '\\': value.Append('\\'); break;
                    case '/': value.Append('/'); break;
                    case 'b': value.Append('\b'); break;
                    case 'f': value.Append('\f'); break;
                    case 'n': value.Append('\n'); break;
                    case 'r': value.Append('\r'); break;
                    case 't': value.Append('\t'); break;
                    case 'u': value.Append(ReadHexCharacter()); break;
                    default: throw new Failure("invalid");
                }
            }
            throw new Failure("invalid");
        }

        private char ReadHexCharacter()
        {
            if (text.Length - position < 4)
                throw new Failure("invalid");
            int value = 0;
            for (int i = 0; i < 4; i++)
            {
                char character = text[position++];
                int digit;
                if (character >= '0' && character <= '9')
                    digit = character - '0';
                else if (character >= 'a' && character <= 'f')
                    digit = character - 'a' + 10;
                else if (character >= 'A' && character <= 'F')
                    digit = character - 'A' + 10;
                else
                    throw new Failure("invalid");
                value = (value << 4) | digit;
            }
            return (char)value;
        }

        private int ReadInteger()
        {
            int start = position;
            if (position < text.Length && text[position] == '-')
                position++;
            if (position >= text.Length || text[position] < '0' || text[position] > '9')
                throw new Failure("invalid");
            if (text[position] == '0')
                position++;
            else
            {
                while (position < text.Length && text[position] >= '0' && text[position] <= '9')
                    position++;
            }
            int value;
            if (!int.TryParse(text.Substring(start, position - start), NumberStyles.AllowLeadingSign,
                CultureInfo.InvariantCulture, out value))
                throw new Failure("invalid");
            return value;
        }

        private void SkipWhitespace()
        {
            while (position < text.Length && (text[position] == ' ' || text[position] == '\t'))
                position++;
        }

        private bool Take(char character)
        {
            if (position >= text.Length || text[position] != character)
                return false;
            position++;
            return true;
        }

        private void Expect(char character)
        {
            SkipWhitespace();
            if (!Take(character))
                throw new Failure("invalid");
        }
    }
}
'@
        if ($AutoCodeInternalTrace) {
            try {
                $elapsed = [long][Math]::Floor(([Diagnostics.Stopwatch]::GetTimestamp() - $traceStartTicks) * 1000.0 / [Diagnostics.Stopwatch]::Frequency)
                [Console]::Error.Write(('ACW_INTERNAL_STAGE_V1|nativecompile-before|{0}|0' -f $elapsed.ToString([Globalization.CultureInfo]::InvariantCulture)) + "`n")
                [Console]::Error.Flush()
            }
            catch { }
        }
        Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'System.Security.dll' -ErrorAction Stop | Out-Null
        if ($AutoCodeInternalTrace) {
            try {
                $elapsed = [long][Math]::Floor(([Diagnostics.Stopwatch]::GetTimestamp() - $traceStartTicks) * 1000.0 / [Diagnostics.Stopwatch]::Frequency)
                [Console]::Error.Write(('ACW_INTERNAL_STAGE_V1|nativecompile-after|{0}|0' -f $elapsed.ToString([Globalization.CultureInfo]::InvariantCulture)) + "`n")
                [Console]::Error.Flush()
            }
            catch { }
        }
        [AutoCodeWindowsCredentials]::Run([bool] $AutoCodeInternalTrace, $traceStartTicks)
    } *> $null
}
catch {
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('{"version":1,"status":"error","code":"failed"}' + "`n")
        $stdout = [Console]::OpenStandardOutput()
        $stdout.Write($bytes, 0, $bytes.Length)
        $stdout.Flush()
        $stdout.Dispose()
    }
    catch {
    }
}
