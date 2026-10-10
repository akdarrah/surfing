// Text players publish: names and chat are free-form (trimmed, control characters removed, length-capped).
pub fn clean_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

// Names are whatever the player typed; only an empty one gets a default.
pub fn name(s: &str, id: u16) -> String {
    let n = clean_text(s, 24);
    if n.is_empty() { format!("Pilot {id}") } else { n }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_pass_through_unless_empty() {
        assert_eq!(name("  ", 7), "Pilot 7");
        assert_eq!(name("xXx_Sl4yer_xXx", 8), "xXx_Sl4yer_xXx");
        assert_eq!(name("a\u{7}b", 9), "ab");
        assert_eq!(clean_text("0123456789", 4), "0123");
    }
}
