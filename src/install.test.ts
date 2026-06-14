import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { deriveShimFilename, getShimPath } from "./install"

describe("install plugin shim", () => {
    test("deriveShimFilename uses package basename without npm namespace", () => {
        expect(deriveShimFilename("@ahumandev/autocode")).toBe("autocode.js")
        expect(deriveShimFilename("pluginname")).toBe("pluginname.js")
    })

    test("deriveShimFilename falls back to safe plugin filename", () => {
        expect(deriveShimFilename("@scope/")).toBe("plugin.js")
        expect(deriveShimFilename("///")).toBe("plugin.js")
        expect(deriveShimFilename("name with spaces")).toBe("name-with-spaces.js")
    })

    test("getShimPath uses derived shim filename in plugin path", () => {
        expect(getShimPath("/tmp/home", "@ahumandev/autocode")).toBe(join("/tmp/home", ".config", "opencode", "plugins", "autocode.js"))
    })
})
