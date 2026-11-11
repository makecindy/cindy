//! 打开 `kcp` 特性时编译 fetch-kcp.sh 下载的真实 KCP，以及设置 KCP 内部字段的 kcp-tune.c。默认构建什么都不做。
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=kcp-tune.c");
    if std::env::var_os("CARGO_FEATURE_KCP").is_none() {
        return;
    }
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let vendor = manifest.join("vendor-test-only");
    assert!(vendor.join("ikcp.c").exists(), "run ./fetch-kcp.sh first");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("out dir"));
    let compiler = std::env::var("CC").unwrap_or_else(|_| "cc".into());
    let mut objects = Vec::new();
    for (source, name) in [(vendor.join("ikcp.c"), "ikcp.o"), (manifest.join("kcp-tune.c"), "kcp-tune.o")] {
        let object = out.join(name);
        let status = Command::new(&compiler)
            .args(["-O2", "-c", "-I"])
            .arg(&vendor)
            .arg(&source)
            .arg("-o")
            .arg(&object)
            .status()
            .expect("run the C compiler");
        assert!(status.success(), "failed to compile {}", source.display());
        objects.push(object);
    }
    let status = Command::new("ar").arg("crs").arg(out.join("libikcp.a")).args(&objects).status().expect("run ar");
    assert!(status.success(), "failed to archive ikcp");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=ikcp");
}
