// Text that strangers publish to every player: names and the winner's promo.
// ponytail: a small blocklist with leetspeak folding; swap for a real moderation API if abuse gets creative.
// Matched anywhere, even with spaces removed ("N I G G E R").
const ANYWHERE: &[&str] = &["nigger", "nigga", "faggot", "fagot", "retard", "tranny", "wetback", "fuck", "shit", "cunt", "onlyfans", "porn"];
// Matched as whole words only, so "grape", "spice" and "raccoon" survive.
const WORDS: &[&str] = &["kike", "spic", "chink", "coon", "bitch", "whore", "slut", "rape", "nazi", "hitler", "xxx", "fag"];

fn fold(s: &str) -> String {
    s.chars()
        .filter_map(|c| match c.to_ascii_lowercase() {
            '0' => Some('o'),
            '1' | '!' | '|' => Some('i'),
            '3' => Some('e'),
            '4' | '@' => Some('a'),
            '5' | '$' => Some('s'),
            '7' => Some('t'),
            c if c.is_ascii_alphabetic() => Some(c),
            _ => None,
        })
        .collect()
}

pub fn is_clean(s: &str) -> bool {
    let f = fold(s);
    if ANYWHERE.iter().any(|w| f.contains(w)) {
        return false;
    }
    !s.split(|c: char| c.is_whitespace() || c == '.' || c == ',' || c == '-' || c == '_' || c == '/')
        .map(fold)
        .any(|t| WORDS.iter().any(|w| t == *w || t.strip_suffix('s') == Some(*w)))
}

pub fn clean_text(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

pub fn name(s: &str, id: u16) -> String {
    let n = clean_text(s, 24);
    if n.is_empty() || !is_clean(&n) { format!("Sailor {id}") } else { n }
}

pub fn url(s: &str) -> Result<Option<String>, &'static str> {
    let s = s.trim();
    if s.is_empty() {
        return Ok(None);
    }
    if s.len() > 200 || !s.starts_with("https://") || s.len() < 12 {
        return Err("link must be https:// and under 200 characters");
    }
    if s.chars().any(|c| c.is_whitespace() || c.is_control() || "<>\"'`\\".contains(c)) {
        return Err("link has characters that aren't allowed");
    }
    if !is_clean(s) {
        return Err("let's keep it friendly");
    }
    Ok(Some(s.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_slurs_and_leetspeak() {
        assert!(!is_clean("you are a f4gg0t"));
        assert!(!is_clean("N I G G E R"));
        assert!(is_clean("Check out my bakery!"));
        assert!(is_clean("grape spice raccoon"));
        assert!(!is_clean("total nazis"));
    }

    #[test]
    fn urls_must_be_https_and_plain() {
        assert_eq!(url(""), Ok(None));
        assert!(url("http://example.com").is_err());
        assert!(url("javascript:alert(1)").is_err());
        assert!(url("https://example.com/\"onmouseover").is_err());
        assert_eq!(url("https://example.com/shop"), Ok(Some("https://example.com/shop".into())));
    }

    #[test]
    fn names_fall_back_when_dirty_or_empty() {
        assert_eq!(name("  ", 7), "Sailor 7");
        assert_eq!(name("shithead", 8), "Sailor 8");
        assert_eq!(name("Captain Soggy Biscuit", 9), "Captain Soggy Biscuit");
    }
}
