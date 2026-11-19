use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPolicy {
    pub(crate) generation: f64,
    pub(crate) requested_generation: f64,
    pub(crate) current_generation: Option<f64>,
    pub(crate) revision: f64,
    pub(crate) checks_revision: bool,
    pub(crate) requested_revision: Option<f64>,
    pub(crate) requested_time: Option<f64>,
    pub(crate) current_time: Option<f64>,
    pub(crate) force: bool,
}

pub(crate) enum ProgressDecision {
    Advance,
    GenerationMismatch,
    Reset,
    Conflict,
    Keep,
}

impl ProgressPolicy {
    pub(crate) fn decide(self) -> ProgressDecision {
        if self.requested_generation != self.generation {
            return if self.current_generation == Some(self.generation) {
                ProgressDecision::GenerationMismatch
            } else {
                ProgressDecision::Reset
            };
        }
        if self.checks_revision && self.requested_revision != Some(self.revision) {
            return ProgressDecision::Conflict;
        }
        if !self.force
            && !self.checks_revision
            && self
                .requested_time
                .zip(self.current_time)
                .is_some_and(|(requested, current)| requested < current)
        {
            return ProgressDecision::Keep;
        }
        ProgressDecision::Advance
    }
}
