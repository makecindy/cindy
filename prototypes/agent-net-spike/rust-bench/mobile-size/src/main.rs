use iroh::{Endpoint, RelayMode, endpoint::presets};

#[tokio::main]
async fn main() {
    let endpoint = Endpoint::builder(presets::Minimal)
        .alpns(vec![b"cindy/agent-net/0".to_vec()])
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .expect("bind");
    println!("{}", endpoint.id());
}
