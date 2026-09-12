import AppKit
import CoreBluetooth

let serviceID = CBUUID(string: "C1DC0001-51C4-499D-A186-4621A4938301")
let receiveID = CBUUID(string: "C1DC0001-51C4-499D-A186-4621A4938302")
let transmitID = CBUUID(string: "C1DC0001-51C4-499D-A186-4621A4938303")
let voiceID = CBUUID(string: "C1DC0001-51C4-499D-A186-4621A4938304")
func emit(_ value: [String: Any]) {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value) else { return }
    FileHandle.standardOutput.write(bytes + Data([10]))
}

// All CoreBluetooth state is confined to the main queue. One acknowledged write
// at a time; the parent only sends the next snapshot after the idle event.
final class Passport: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    var central: CBCentralManager!
    var device: CBPeripheral?
    var receive: CBCharacteristic?
    var transmit: CBCharacteristic?
    var devices: [UUID: CBPeripheral] = [:]
    var outgoing = Data()
    var offset = 0
    var writing = false
    var reading = false
    var ready = false
    var epoch = 0
    var retry: DispatchWorkItem?
    var attempts = 0
    var seen: [UUID: Date] = [:]
    var deadline: DispatchWorkItem?
    let preferences: UserDefaults
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let zh = Locale.preferredLanguages.first?.hasPrefix("zh") == true
    var selected: String? { preferences.string(forKey: "device") }
    init(profile: String) {
        preferences = UserDefaults(suiteName: "app.cindy.passport." + profile)!
        super.init()
        item.button?.title = "Cindy BLE"
        central = CBCentralManager(delegate: self, queue: .main)
        refreshMenu()
    }
    func refreshMenu() {
        let menu = NSMenu()
        let state = ready ? (zh ? "已连接" : "Connected") : (zh ? "选择设备" : "Choose device")
        menu.addItem(withTitle: state, action: nil, keyEquivalent: "")
        for p in devices.values.sorted(by: { $0.identifier.uuidString < $1.identifier.uuidString }) {
            let entry = NSMenuItem(title: "Cindy Passport · " + p.identifier.uuidString.prefix(8), action: #selector(choose(_:)), keyEquivalent: "")
            entry.target = self; entry.representedObject = p.identifier
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        let disconnect = NSMenuItem(title: zh ? "断开并取消自动连接" : "Disconnect and stop reconnecting", action: #selector(forget), keyEquivalent: "")
        disconnect.target = self; menu.addItem(disconnect)
        item.menu = menu
        emit(["kind": "devices", "devices": devices.keys.map { $0.uuidString }, "bluetooth": central?.state.rawValue ?? 0])
    }
    @objc func choose(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? UUID else { return }
        connect(id)
    }
    func connect(_ id: UUID) {
        guard let next = devices[id] else { return }
        preferences.set(id.uuidString, forKey: "device")
        attempts = 0
        reset()
        if let old = device { central.cancelPeripheralConnection(old) }
        device = next; next.delegate = self
        central.connect(next)
    }
    @objc func forget() {
        preferences.removeObject(forKey: "device")
        reset()
        if let old = device { central.cancelPeripheralConnection(old) }
        device = nil
    }
    func reset() {
        epoch += 1; retry?.cancel(); retry = nil; deadline?.cancel(); deadline = nil
        ready = false; writing = false; reading = false
        receive = nil; transmit = nil; outgoing.removeAll(); offset = 0
        emit(["kind": "disconnected"]); refreshMenu()
    }
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard central.state == .poweredOn else { reset(); device = nil; return }
        central.scanForPeripherals(withServices: [serviceID])
        if let text = selected, let id = UUID(uuidString: text),
           let known = central.retrievePeripherals(withIdentifiers: [id]).first {
            device = known; known.delegate = self; central.connect(known)
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover p: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        devices[p.identifier] = p; refreshMenu()
        guard selected == p.identifier.uuidString else { return }
        let now = Date()
        // The page that owns the radio stops advertising when it closes, so a
        // fresh sighting after a gap means the device just came back. Reconnect
        // at once with a cleared backoff, but only then: a device that keeps
        // advertising while connect() fails must not be hammered.
        let gap = now.timeIntervalSince(seen[p.identifier] ?? .distantPast)
        seen[p.identifier] = now
        if device == nil || (p.state == .disconnected && gap >= 5) {
            attempts = 0
            retry?.cancel(); retry = nil
            device = p; p.delegate = self
            central.connect(p)
        }
    }
    func centralManager(_ central: CBCentralManager, didConnect p: CBPeripheral) {
        guard p == device else { central.cancelPeripheralConnection(p); return }
        attempts = 0
        p.discoverServices([serviceID])
    }
    func reconnect(_ p: CBPeripheral) {
        guard p == device else { return }
        reset()
        guard selected == p.identifier.uuidString, central.state == .poweredOn else { device = nil; return }
        let generation = epoch
        // macOS denies connections from a central that retries without pause, so
        // back off 3s, 6s, 12s, 24s and then 30s instead of reconnecting on a
        // fixed interval.
        attempts = min(attempts + 1, 5)
        let delay = min(30, 3 * pow(2, Double(attempts - 1)))
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.epoch == generation, self.selected == p.identifier.uuidString else { return }
            self.central.connect(p)
        }
        retry = work; DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) { reconnect(p) }
    func centralManager(_ central: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) { reconnect(p) }
    func fail(_ p: CBPeripheral) { if p == device { central.cancelPeripheralConnection(p) } }
    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard p == device, error == nil, let service = p.services?.first(where: { $0.uuid == serviceID }) else { fail(p); return }
        p.discoverCharacteristics([receiveID, transmitID, voiceID], for: service)
    }
    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard p == device, error == nil else { fail(p); return }
        receive = service.characteristics?.first { $0.uuid == receiveID }
        transmit = service.characteristics?.first { $0.uuid == transmitID }
        guard receive != nil, let tx = transmit else { fail(p); return }
        if let voice = service.characteristics?.first(where: { $0.uuid == voiceID }) {
            p.setNotifyValue(true, for: voice)
        }
        p.setNotifyValue(true, for: tx)
    }
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard p == device, error == nil, characteristic.isNotifying else { fail(p); return }
        if characteristic.uuid == voiceID { return }
        // Authenticated GATT read invokes the system's passkey pairing dialog.
        reading = true; p.readValue(for: characteristic)
    }
    func peripheral(_ p: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard p == device, error == nil, let bytes = characteristic.value else { fail(p); return }
        if characteristic.uuid == voiceID {
            guard ready, bytes.count >= 7, bytes.count <= 200 else { fail(p); return }
            emit(["kind": "voice", "packet": bytes.base64EncodedString()])
            return
        }
        if bytes.count == 1 && bytes[0] == 1 {
            if !reading { reading = true; p.readValue(for: characteristic) }
            return
        }
        if bytes.count == 46 && bytes[0] == 2 {
            let raw = bytes.subdata(in: 2..<42)
            guard ready, bytes[1] >= 1, bytes[1] <= 6,
                  let end = raw.firstIndex(of: 0), end > 0,
                  raw[end...].allSatisfy({ $0 == 0 }),
                  let id = String(data: raw.prefix(end), encoding: .utf8) else { fail(p); return }
            var token: UInt32 = 0
            for i in 0..<4 { token |= UInt32(bytes[42 + i]) << (i * 8) }
            emit(["kind": "action", "action": Int(bytes[1]), "id": id, "token": token])
            return
        }
        guard bytes.count == 40 else { fail(p); return }
        reading = false
        if !ready {
            ready = true; emit(["kind": "ready"]); refreshMenu()
            return // Never replay the previous open action on reconnect.
        }
        let idBytes = bytes.prefix { $0 != 0 }
        guard !idBytes.isEmpty, let id = String(data: Data(idBytes), encoding: .utf8) else { return }
        emit(["kind": "open", "id": id])
    }
    func send(_ bytes: Data) {
        guard ready, !writing, outgoing.isEmpty, bytes.count >= 4, bytes.count <= 2628 else { return }
        outgoing = bytes; offset = 0; writeNext()
    }
    func writeNext() {
        guard let p = device, let rx = receive, ready else { return }
        if offset == outgoing.count {
            outgoing.removeAll(); writing = false; emit(["kind": "idle"]); return
        }
        let n = min(512, p.maximumWriteValueLength(for: .withResponse), outgoing.count - offset)
        guard n > 0 else { fail(p); return }
        let chunk = outgoing.subdata(in: offset..<(offset + n)); offset += n; writing = true
        deadline?.cancel()
        let generation = epoch
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, self.epoch == generation, self.writing else { return }
            self.fail(p)
        }
        deadline = timeout; DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)
        p.writeValue(chunk, for: rx, type: .withResponse)
    }
    func peripheral(_ p: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard p == device, error == nil else { fail(p); return }
        deadline?.cancel(); deadline = nil
        writeNext()
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let profile = CommandLine.arguments.dropFirst().first ?? "standalone"
let passport = Passport(profile: profile)
DispatchQueue.global().async {
    var buffer = Data()
    while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty { DispatchQueue.main.async { app.terminate(nil) }; return }
        for byte in chunk {
            if byte == 10 {
                let line = buffer; buffer.removeAll(keepingCapacity: true)
                if let command = (try? JSONSerialization.jsonObject(with: line)) as? [String: String] {
                    DispatchQueue.main.async {
                        if command["kind"] == "forget" { passport.forget() }
                        if command["kind"] == "connect", let text = command["id"], let id = UUID(uuidString: text) { passport.connect(id) }
                    }
                    continue
                }
                guard let decoded = Data(base64Encoded: line), decoded.count <= 2628 else { continue }
                DispatchQueue.main.async { passport.send(decoded) }
            } else {
                buffer.append(byte)
                if buffer.count > 4096 { exit(2) }
            }
        }
    }
}
app.run()
