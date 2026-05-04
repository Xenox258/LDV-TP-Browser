use argon2::{Argon2, PasswordHasher};
use argon2::password_hash::SaltString;
use rand_core::OsRng;

fn main() {
    let password = std::env::args().nth(1).unwrap_or_default();
    if password.is_empty() {
        eprintln!("Usage: cargo run --bin hash_password -- <mot_de_passe>");
        std::process::exit(1);
    }

    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .expect("hash error")
        .to_string();

    println!("{}", hash);
}
