import { Server, utils } from "ssh2"
import type { AuthContext, Connection } from "ssh2"

const password = "local-test-password"
const passphrase = "local-test-key-passphrase"
const hostKey = utils.generateKeyPairSync("ed25519").private
const ed25519Key = utils.generateKeyPairSync("ed25519").private
const rsaKey = utils.generateKeyPairSync("rsa", { bits: 3072 }).private
const encryptedRsaKey = utils.generateKeyPairSync("rsa", { bits: 3072, passphrase, cipher: "aes256-ctr", rounds: 16 }).private

type Handle = { path: string; directory: boolean; listed?: boolean }
type SftpServer = {
    on(event: string, listener: (...args: never[]) => void): SftpServer
    handle(requestId: number, handle: Buffer): void
    status(requestId: number, code: number): void
    data(requestId: number, data: Buffer): void
    attrs(requestId: number, attrs: Record<string, number>): void
    name(requestId: number, names: Array<{ filename: string; longname: string; attrs: Record<string, number> }>): void
}

export const localSshCredentials = { password, passphrase, ed25519Key, rsaKey, encryptedRsaKey }

export class LocalSshServer {
    private readonly files = new Map<string, Buffer>()
    private readonly directories = new Set<string>(["/"])
    private readonly connections = new Set<Connection>()
    private readonly publicKeyHashAlgorithms: string[] = []
    private readonly server = new Server({ hostKeys: [hostKey] }, (connection) => this.configureConnection(connection))
    private portValue?: number

    async start(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.server.once("error", reject)
            this.server.listen(0, "127.0.0.1", () => {
                this.server.removeListener("error", reject)
                const address = this.server.address()
                if (!address || typeof address === "string") {
                    reject(new Error("Local SSH server did not receive a TCP port"))
                    return
                }
                this.portValue = address.port
                resolve()
            })
        })
    }

    get port(): number {
        if (this.portValue === undefined) throw new Error("Local SSH server is not started")
        return this.portValue
    }

    get authenticatedPublicKeyAlgorithms(): readonly string[] {
        return this.publicKeyHashAlgorithms
    }

    async close(): Promise<void> {
        for (const connection of this.connections) connection.end()
        await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()))
    }

    private configureConnection(connection: Connection): void {
        this.connections.add(connection)
        connection.on("close", () => this.connections.delete(connection))
        connection.on("authentication", (context: AuthContext) => this.authenticate(context))
        connection.on("session", (accept) => {
            const session = accept()
            session.on("exec", (accept, _reject, info) => {
                const stream = accept()
                stream.exit(0)
                stream.end(info.command === "local-ssh-test" ? "local exec output\n" : "")
            })
            session.on("sftp", (accept) => this.configureSftp(accept() as unknown as SftpServer))
        })
    }

    private authenticate(context: AuthContext): void {
        if (context.username !== "local-user") {
            context.reject(["password", "publickey"])
            return
        }
        if (context.method === "password" && context.password === password) {
            context.accept()
            return
        }
        if (context.method === "publickey" && !context.signature) {
            context.accept()
            return
        }
        if (context.method === "publickey" && context.signature) {
            if (context.hashAlgo) this.publicKeyHashAlgorithms.push(context.hashAlgo)
            context.accept()
            return
        }
        context.reject(["password", "publickey"])
    }

    private configureSftp(sftp: SftpServer): void {
        const handles = new Map<string, Handle>()
        let nextHandle = 0
        const createHandle = (handle: Handle): Buffer => {
            const value = Buffer.from(String(nextHandle++))
            handles.set(value.toString("hex"), handle)
            return value
        }
        const getHandle = (handle: Buffer): Handle | undefined => handles.get(handle.toString("hex"))
        const attrs = (path: string): Record<string, number> | undefined => {
            if (this.directories.has(path)) return { mode: 0o040755, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }
            const file = this.files.get(path)
            return file ? { mode: 0o100644, size: file.length, uid: 0, gid: 0, atime: 0, mtime: 0 } : undefined
        }
        const statusMissing = (requestId: number): void => sftp.status(requestId, utils.sftp.STATUS_CODE.NO_SUCH_FILE)

        sftp.on("REALPATH", (requestId: number, path: string) => sftp.name(requestId, [{ filename: path || "/", longname: path || "/", attrs: attrs(path || "/") ?? {} }]))
        sftp.on("STAT", (requestId: number, path: string) => {
            const result = attrs(path)
            if (result) sftp.attrs(requestId, result)
            else statusMissing(requestId)
        })
        sftp.on("LSTAT", (requestId: number, path: string) => {
            const result = attrs(path)
            if (result) sftp.attrs(requestId, result)
            else statusMissing(requestId)
        })
        sftp.on("OPEN", (requestId: number, path: string, flags: number) => {
            if (!this.files.has(path) && !(flags & utils.sftp.OPEN_MODE.CREAT)) {
                statusMissing(requestId)
                return
            }
            if (flags & utils.sftp.OPEN_MODE.TRUNC) this.files.set(path, Buffer.alloc(0))
            if (!this.files.has(path)) this.files.set(path, Buffer.alloc(0))
            sftp.handle(requestId, createHandle({ path, directory: false }))
        })
        sftp.on("READ", (requestId: number, handle: Buffer, offset: number, length: number) => {
            const state = getHandle(handle)
            const file = state && this.files.get(state.path)
            if (!file) {
                statusMissing(requestId)
                return
            }
            const chunk = file.subarray(offset, offset + length)
            if (chunk.length) sftp.data(requestId, chunk)
            else sftp.status(requestId, utils.sftp.STATUS_CODE.EOF)
        })
        sftp.on("WRITE", (requestId: number, handle: Buffer, offset: number, data: Buffer) => {
            const state = getHandle(handle)
            if (!state) {
                statusMissing(requestId)
                return
            }
            const file = this.files.get(state.path) ?? Buffer.alloc(0)
            const output = Buffer.alloc(Math.max(file.length, offset + data.length))
            file.copy(output)
            data.copy(output, offset)
            this.files.set(state.path, output)
            sftp.status(requestId, utils.sftp.STATUS_CODE.OK)
        })
        sftp.on("CLOSE", (requestId: number, handle: Buffer) => {
            handles.delete(handle.toString("hex"))
            sftp.status(requestId, utils.sftp.STATUS_CODE.OK)
        })
        sftp.on("MKDIR", (requestId: number, path: string) => {
            this.directories.add(path)
            sftp.status(requestId, utils.sftp.STATUS_CODE.OK)
        })
        sftp.on("OPENDIR", (requestId: number, path: string) => {
            if (!this.directories.has(path)) {
                statusMissing(requestId)
                return
            }
            sftp.handle(requestId, createHandle({ path, directory: true }))
        })
        sftp.on("READDIR", (requestId: number, handle: Buffer) => {
            const state = getHandle(handle)
            if (!state?.directory || state.listed) {
                sftp.status(requestId, utils.sftp.STATUS_CODE.EOF)
                return
            }
            state.listed = true
            const prefix = state.path === "/" ? "/" : `${state.path}/`
            const names = [...this.directories, ...this.files.keys()]
                .filter((path) => path.startsWith(prefix) && path.slice(prefix.length).length > 0 && !path.slice(prefix.length).includes("/"))
                .map((path) => ({ filename: path.slice(prefix.length), longname: path.slice(prefix.length), attrs: attrs(path) ?? {} }))
            sftp.name(requestId, names)
        })
        sftp.on("REMOVE", (requestId: number, path: string) => {
            if (!this.files.delete(path)) {
                statusMissing(requestId)
                return
            }
            sftp.status(requestId, utils.sftp.STATUS_CODE.OK)
        })
        sftp.on("RENAME", (requestId: number, oldPath: string, newPath: string) => {
            const file = this.files.get(oldPath)
            if (!file) {
                statusMissing(requestId)
                return
            }
            this.files.delete(oldPath)
            this.files.set(newPath, file)
            sftp.status(requestId, utils.sftp.STATUS_CODE.OK)
        })
    }
}
