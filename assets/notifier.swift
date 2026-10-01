// tunnelvision's macOS notifier, compiled on the user's machine by src/notify.ts.
//
// Launched (through LaunchServices) with a JSON payload path, it posts one
// notification with action buttons and exits. When the user clicks the
// notification or a button, macOS relaunches it with no payload, and it runs
// that action's command. Clicking the notification itself runs the first action.

import AppKit
import UserNotifications

struct Action: Codable {
	let id: String
	let title: String
	/// Absolute executable path, then its arguments.
	let argv: [String]
	let cwd: String?
	/** File the command's output is appended to; discarded when absent. */
	let log: String?
}

struct Payload: Codable {
	let title: String
	let subtitle: String?
	let body: String
	let actions: [Action]
}

func fail(_ message: String, _ code: Int32) -> Never {
	FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
	exit(code)
}

final class Delegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
	let payloadPath: String?

	init(payloadPath: String?) {
		self.payloadPath = payloadPath
	}

	func applicationDidFinishLaunching(_ note: Notification) {
		let center = UNUserNotificationCenter.current()
		center.delegate = self
		guard let path = payloadPath else {
			// Relaunched to handle a click; give up if no response arrives.
			DispatchQueue.main.asyncAfter(deadline: .now() + 10) { NSApp.terminate(nil) }
			return
		}
		let url = URL(fileURLWithPath: path)
		guard let data = try? Data(contentsOf: url), let payload = try? JSONDecoder().decode(Payload.self, from: data) else {
			fail("unreadable payload at \(path)", 2)
		}
		try? FileManager.default.removeItem(at: url)
		center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
			if granted { return self.post(payload, center) }
			// The first time, the permission prompt can answer before the user
			// does; keep checking for a minute in case they allow it.
			self.waitForAuthorization(center, attempts: 60) { self.post(payload, center) }
		}
	}

	func waitForAuthorization(_ center: UNUserNotificationCenter, attempts: Int, then: @escaping () -> Void) {
		center.getNotificationSettings { settings in
			if settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional { return then() }
			if attempts <= 0 { fail("notifications are not allowed for tunnelvision", 3) }
			DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
				self.waitForAuthorization(center, attempts: attempts - 1, then: then)
			}
		}
	}

	func post(_ payload: Payload, _ center: UNUserNotificationCenter) {
		// One category per notification, so each can carry its own buttons.
		let category = UUID().uuidString
		let actions = payload.actions.map { UNNotificationAction(identifier: $0.id, title: $0.title, options: [.foreground]) }
		center.getNotificationCategories { existing in
			center.setNotificationCategories(existing.union([
				UNNotificationCategory(identifier: category, actions: actions, intentIdentifiers: []),
			]))
			let content = UNMutableNotificationContent()
			content.title = payload.title
			if let subtitle = payload.subtitle { content.subtitle = subtitle }
			content.body = payload.body
			content.categoryIdentifier = category
			content.sound = .default
			let encoded = (try? JSONEncoder().encode(payload.actions)).flatMap { String(data: $0, encoding: .utf8) }
			content.userInfo = ["actions": encoded ?? "[]"]
			center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { error in
				if let error { fail("couldn't post the notification: \(error.localizedDescription)", 4) }
				exit(0)
			}
		}
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		didReceive response: UNNotificationResponse,
		withCompletionHandler done: @escaping () -> Void
	) {
		let json = response.notification.request.content.userInfo["actions"] as? String ?? "[]"
		let actions = (try? JSONDecoder().decode([Action].self, from: Data(json.utf8))) ?? []
		let chosen = response.actionIdentifier == UNNotificationDefaultActionIdentifier
			? actions.first
			: actions.first { $0.id == response.actionIdentifier }
		if let action = chosen, let exe = action.argv.first {
			let process = Process()
			process.executableURL = URL(fileURLWithPath: exe)
			process.arguments = Array(action.argv.dropFirst())
			if let cwd = action.cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
			if let log = action.log {
				if !FileManager.default.fileExists(atPath: log) { FileManager.default.createFile(atPath: log, contents: nil) }
				if let handle = FileHandle(forWritingAtPath: log) {
					handle.seekToEndOfFile()
					process.standardOutput = handle
					process.standardError = handle
				}
			}
			do { try process.run() } catch { FileHandle.standardError.write("couldn't run \(exe): \(error)\n".data(using: .utf8)!) }
		}
		done()
		DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter,
		willPresent notification: UNNotification,
		withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
	) {
		done([.banner, .list, .sound])
	}
}

let args = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
let app = NSApplication.shared
let delegate = Delegate(payloadPath: args.first)
app.delegate = delegate
app.setActivationPolicy(.prohibited)
app.run()
