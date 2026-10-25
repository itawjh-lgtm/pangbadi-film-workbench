import AppKit

// Local vector artwork. No remote assets, AI generation, fonts, or network access.
@main
struct DrawStudioIcon {
    static let cream = NSColor(calibratedRed: 0.962, green: 0.957, blue: 0.928, alpha: 1)
    static let olive = NSColor(calibratedRed: 0.255, green: 0.330, blue: 0.278, alpha: 1)

    static func star(center: NSPoint, radius: CGFloat) -> NSBezierPath {
        let path = NSBezierPath()
        for index in 0..<8 {
            let angle = CGFloat(index) * .pi / 4
            let r = index.isMultiple(of: 2) ? radius : radius * 0.31
            let point = NSPoint(x: center.x + cos(angle) * r, y: center.y + sin(angle) * r)
            if index == 0 { path.move(to: point) } else { path.line(to: point) }
        }
        path.close(); return path
    }

    static func paint() {
        let tile = NSBezierPath(roundedRect: NSRect(x: 76, y: 76, width: 872, height: 872), xRadius: 190, yRadius: 190)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow(); shadow.shadowColor = NSColor.black.withAlphaComponent(0.16)
        shadow.shadowBlurRadius = 34; shadow.shadowOffset = NSSize(width: 0, height: -10); shadow.set()
        cream.setFill(); tile.fill()
        NSGraphicsContext.restoreGraphicsState()
        let gradient = NSGradient(starting: NSColor.white.withAlphaComponent(0.72), ending: NSColor(calibratedRed: 0.84, green: 0.87, blue: 0.82, alpha: 0.4))!
        gradient.draw(in: tile, angle: -65)
        NSColor.white.withAlphaComponent(0.8).setStroke(); tile.lineWidth = 3; tile.stroke()

        // A quiet film window with a forward play mark and one small dream star.
        let screen = NSBezierPath(roundedRect: NSRect(x: 250, y: 320, width: 520, height: 380), xRadius: 87, yRadius: 87)
        olive.setFill(); screen.fill()
        let inner = NSBezierPath(roundedRect: NSRect(x: 293, y: 363, width: 434, height: 294), xRadius: 48, yRadius: 48)
        cream.setFill(); inner.fill()
        let play = NSBezierPath()
        play.move(to: NSPoint(x: 465, y: 431))
        play.curve(to: NSPoint(x: 487, y: 419), controlPoint1: NSPoint(x: 465, y: 419), controlPoint2: NSPoint(x: 477, y: 413))
        play.line(to: NSPoint(x: 610, y: 494))
        play.curve(to: NSPoint(x: 610, y: 519), controlPoint1: NSPoint(x: 624, y: 502), controlPoint2: NSPoint(x: 624, y: 511))
        play.line(to: NSPoint(x: 487, y: 594))
        play.curve(to: NSPoint(x: 465, y: 582), controlPoint1: NSPoint(x: 477, y: 600), controlPoint2: NSPoint(x: 465, y: 594))
        play.close(); olive.setFill(); play.fill()

        let frameAccent = NSBezierPath()
        frameAccent.move(to: NSPoint(x: 319, y: 759))
        frameAccent.curve(to: NSPoint(x: 640, y: 790), controlPoint1: NSPoint(x: 400, y: 787), controlPoint2: NSPoint(x: 531, y: 805))
        frameAccent.lineCapStyle = .round; frameAccent.lineWidth = 26
        olive.withAlphaComponent(0.62).setStroke(); frameAccent.stroke()
        olive.setFill(); star(center: NSPoint(x: 766, y: 766), radius: 64).fill()
        let foot = NSBezierPath(roundedRect: NSRect(x: 408, y: 239, width: 208, height: 23), xRadius: 11.5, yRadius: 11.5)
        olive.withAlphaComponent(0.35).setFill(); foot.fill()
    }

    static func render(size: Int, to destination: URL) throws {
        let image = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        let context = NSGraphicsContext(bitmapImageRep: image)!
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.cgContext.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
        paint()
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let png = image.representation(using: .png, properties: [:]) else { throw NSError(domain: "DrawStudioIcon", code: 1) }
        try png.write(to: destination)
    }

    static func main() throws {
        guard CommandLine.arguments.count == 2 else {
            FileHandle.standardError.write(Data("Usage: DrawIcon /absolute/path/AppIcon.iconset\n".utf8))
            exit(2)
        }
        let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        for points in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let suffix = scale == 2 ? "@2x" : ""
                try render(size: points * scale, to: root.appendingPathComponent("icon_\(points)x\(points)\(suffix).png"))
            }
        }
    }
}
