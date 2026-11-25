import { connectHost } from "@openchamber/sdk"
import type { HostClient, HostReadyContext } from "@openchamber/sdk"
import { mountProfiles } from "./profiles-view.js"
import { mountSettings } from "./settings-view.js"
import { createSdkTransport } from "./sdk-transport.js"

function cleanup(action: () => void): void {
    try { action() } catch {}
}

function start(): void {
    const settingsRoot = document.getElementById("settings-root")
    const profilesRoot = document.getElementById("profiles-root")
    if (!(settingsRoot instanceof HTMLElement) || !(profilesRoot instanceof HTMLElement)) return

    let disposeSettings = mountSettings(settingsRoot)
    let disposeProfiles = mountProfiles(profilesRoot)
    let generation = 0
    let current: string | null | undefined
    let stopped = false
    let ready = false
    let unsubscribeReady: () => void = (): void => {}
    let unsubscribeDirectory: () => void = (): void => {}
    let host: HostClient | undefined
    try {
        host = connectHost()
        const client = host
        const changeDirectory = (directory: string | null): void => {
            if (stopped || current === directory) return
            current = directory
            const mountGeneration = ++generation
            cleanup(disposeSettings)
            cleanup(disposeProfiles)
            const transport = createSdkTransport(client, directory)
            disposeProfiles = mountProfiles(profilesRoot, createSdkTransport(client, directory))
            disposeSettings = mountSettings(settingsRoot, transport, (pending: boolean): void => {
                if (stopped || mountGeneration !== generation) return
                cleanup(disposeProfiles)
                disposeProfiles = pending ? mountProfiles(profilesRoot) : mountProfiles(profilesRoot, createSdkTransport(client, directory))
            })
        }
        unsubscribeReady = client.onReady((context: HostReadyContext): void => {
            ready = true
            changeDirectory(context.directory)
        })
        unsubscribeDirectory = client.onDirectory((directory: string | null): void => {
            if (ready) changeDirectory(directory)
        })
        window.addEventListener("pagehide", (): void => {
            if (stopped) return
            stopped = true
            generation++
            cleanup(unsubscribeReady)
            cleanup(unsubscribeDirectory)
            cleanup(disposeSettings)
            cleanup(disposeProfiles)
            cleanup((): void => client.dispose())
        }, { once: true })
    } catch {
        stopped = true
        cleanup(unsubscribeReady)
        cleanup(unsubscribeDirectory)
        cleanup((): void => host?.dispose())
        cleanup(disposeSettings)
        cleanup(disposeProfiles)
        disposeSettings = mountSettings(settingsRoot)
        disposeProfiles = mountProfiles(profilesRoot)
    }
}

start()
