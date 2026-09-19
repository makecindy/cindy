fn main() {
    napi_build::setup();
    println!("cargo:rustc-link-arg=/DEPENDENTLOADFLAG:0x800");
    if std::env::var_os("CARGO_FEATURE_DEVELOPMENT").is_some() {
        for name in ["CINDY_DESKTOP_DEV_APP", "CINDY_DESKTOP_DEV_EXECUTABLE"] {
            println!("cargo:rerun-if-env-changed={name}");
            let value = std::fs::canonicalize(
                std::env::var_os(name).expect("explicit development binding required"),
            )
            .expect("development binding must exist");
            let value = value.to_str().expect("Unicode development path required");
            assert!(!value.contains(['\r', '\n']));
            println!("cargo:rustc-env={name}={value}");
        }
    }
}
