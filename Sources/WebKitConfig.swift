import WebKit

func enableNativePiP(_ preferences: WKPreferences) -> Bool {
    let setter = NSSelectorFromString("_setAllowsPictureInPictureMediaPlayback:")
    guard preferences.responds(to: setter) else { return false }
    preferences.setValue(true, forKey: "allowsPictureInPictureMediaPlayback")
    return true
}
