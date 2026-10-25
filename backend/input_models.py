import math
from copy import deepcopy
from datetime import date
from typing import Annotated, Any, Literal
from urllib.parse import urlsplit

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, StrictBool, StringConstraints, field_validator, model_validator


def _nonblank(value: str) -> str:
    if not value.strip():
        raise ValueError("Text must not be blank")
    return value


Text200 = Annotated[str, StringConstraints(strict=True, max_length=200)]
Brand = Annotated[Text200, AfterValidator(_nonblank)]
Query = Annotated[str, StringConstraints(strict=True, max_length=2000), AfterValidator(_nonblank)]
Text2000 = Annotated[str, StringConstraints(strict=True, max_length=2000)]
LongText = Annotated[str, StringConstraints(strict=True, max_length=60000)]
Answer = Annotated[str, StringConstraints(strict=True, max_length=200000)]
def _id_range(value: int | str) -> int | str:
    if int(value) > 9223372036854775807:
        raise ValueError("Identifier exceeds the database range")
    return value


Identifier = Annotated[Annotated[int, Field(strict=True, gt=0)] | Annotated[str, StringConstraints(strict=True, pattern=r"^[1-9][0-9]*$", max_length=19)], AfterValidator(_id_range)]
Timestamp = Annotated[int, Field(strict=True, ge=0)]
Number = Annotated[float, Field(strict=True, allow_inf_nan=False)]
Position = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]
Count = Annotated[int, Field(strict=True, ge=0)]
Provider = Literal["gigachat", "deepseek", "yandex", "openai", "gemini", "perplexity"]
CombinedProvider = Provider | Literal["all"]
TaskStatus = Literal["planned", "in_progress", "ready_for_check", "measured"]
WorkType = Literal["content", "seo", "pr", "technical"]
Verdict = Literal["improved", "declined", "unchanged"]
Role = Literal["рекомендация", "сравнение", "упоминание в списке", "упоминание", "не упомянут", ""]
PositionKind = Literal["direct", "weighted"]
Names = Annotated[list[Text200], Field(max_length=500)]
Quotes = Annotated[list[LongText], Field(max_length=500)]
ProviderList = Annotated[list[Provider], Field(max_length=6)]


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class ProviderCall(StrictInput):
    analysis_attempt: Count = None
    analysis_method: Text200 = None
    validation_error: Text200 = None
    check_id: Identifier = None
    stage: Text200 = None
    endpoint: Text2000 = None
    requested_model: Text200 | None = None
    returned_model: Text200 | None = None
    response_id: Text200 = None
    attempt: Count = None
    retry: Count = None
    started_at: Text200 = None
    finished_at: Text200 = None
    status: Text200 = None
    http_status: Annotated[int, Field(strict=True, ge=100, le=599)] = None
    usage: dict[Text200, Number] = None


class Mention(StrictInput):
    name: Brand
    position: Position = None
    role: Role = None
    evidence: LongText = None
    observed_name: Text200 = None
    observed_names: Names = None
    canonical_id: Text200 = None
    canonical_name: Text200 = None
    evidence_spans: Quotes = None
    identity_normalization_version: Text200 = None
    identity_relation: Text200 = None


class Source(StrictInput):
    index: Annotated[int, Field(strict=True, gt=0)] | None = None
    title: Text2000 = None
    url: Text2000 = None
    snippet: LongText = None
    summary: LongText = None
    page_text: Answer = None
    authority_score: Annotated[float, Field(strict=True, ge=0, le=10, allow_inf_nan=False)] = None
    authority_label: Text200 = None
    brand_check_status: Literal["found", "not_found", "unavailable"] = None
    brand_check_basis: Literal["page", "search_snippet", "unavailable"] = None
    brand_matches: Quotes = None
    cited_in_answer: StrictBool = None
    is_brand_source: StrictBool = None


class SourceAnalysis(Source):
    source_index: Annotated[int, Field(strict=True, gt=0)] = None
    authority: Annotated[float, Field(strict=True, ge=0, le=10, allow_inf_nan=False)] = None
    mentions_brand: StrictBool = None
    sentiment: Literal["положительный", "нейтральный", "отрицательный"] = None
    key_point: LongText = None


class AnalysisArtifact(StrictInput):
    brand: Brand = None
    query: Query = None
    provider: CombinedProvider = None
    model: Text2000 = None
    mentioned: StrictBool = None
    position: Position | None = None
    weighted_position: Position | None = None
    positionKind: PositionKind = None
    position_kind: PositionKind = None
    role: Role = None
    reasoning: LongText = None
    quotes: Quotes = None
    competitors: Names = None
    mentioned_brands: Names = None
    ordered_mentions: Annotated[list[Mention], Field(max_length=500)] = None
    orderedMentions: Annotated[list[Mention], Field(max_length=500)] = None
    raw_answer: Answer = None
    rawAnswer: Answer = None
    sources: Annotated[list[Source], Field(max_length=500)] = None
    source_analysis: Annotated[list[SourceAnalysis], Field(max_length=500)] = None
    search_queries: Annotated[list[Text2000], Field(max_length=500)] = None
    web_search_used: StrictBool = None
    google_search_used: StrictBool = None
    rag: StrictBool = None
    provider_calls: Annotated[list[ProviderCall], Field(max_length=500)] = None
    provider_results: Annotated[list["AnalysisArtifact"], Field(max_length=6)] = None
    provider_errors: Annotated[list["AnalysisArtifact"], Field(max_length=6)] = None
    providerResults: Annotated[list["AnalysisArtifact"], Field(max_length=6)] = None
    requested_providers: ProviderList = None
    requestedProviders: ProviderList = None
    sources_count: Count = None
    total_sources: Count = None
    total_sentences: Count | None = None
    canonical_id: Text200 | None = None
    canonicalId: Text200 = None
    canonical_name: Text200 | None = None
    observed_name: Text200 | None = None
    brandKey: Text200 = None
    analysis_provider: Provider = None
    analysis_method: Text200 = None
    analysis_version: Text200 = None
    identity_normalization_version: Text200 = None
    brand_cited: StrictBool = None
    brand_citation_urls: Annotated[list[Text2000], Field(max_length=500)] = None
    citation_domains: Names = None
    market_scope: Text200 = None
    metrics: dict[Text200, Number | None] = None
    error: LongText = None
    analysis_error: StrictBool = None


class SavedCheckInput(AnalysisArtifact):
    brand: Brand
    query: Query


class ProviderSnapshot(StrictInput):
    provider: CombinedProvider = None
    model: Text2000 = None
    mentioned: StrictBool = None
    position: Position | None = None
    positionKind: PositionKind = None
    role: Role = None


class CheckSnapshot(ProviderSnapshot):
    id: Identifier | None = None
    createdAt: Timestamp = None
    providers: ProviderList = None
    providerResults: Annotated[list[ProviderSnapshot], Field(max_length=6)] = None
    competitors: Names = None
    reasoning: LongText = None
    quotes: Quotes = None


class TaskEvidence(StrictInput):
    count: Count = None
    checkIds: Annotated[list[Identifier], Field(max_length=2048)] = None
    competitors: Names = None
    reasoning: LongText = None
    quotes: Quotes = None


class TaskComparison(StrictInput):
    verdict: Verdict
    providers: ProviderList
    unavailable: ProviderList


class TaskFields(StrictInput):
    brand: Brand = None
    brandKey: Text200 = None
    brand_id: Identifier | None = None
    canonical_id: Text200 = None
    canonicalId: Text200 = None
    query: Query = None
    provider: CombinedProvider = None
    providers: ProviderList = None
    model: Text2000 = None
    version: Annotated[int, Field(strict=True, ge=1, le=2)] = None
    opportunityId: Annotated[str, StringConstraints(strict=True, max_length=2500)] = None
    problemType: Literal["brand_missing", "weak_role"] = None
    title: Annotated[Text200, AfterValidator(_nonblank)] = None
    workType: WorkType = None
    owner: Annotated[str, StringConstraints(strict=True, max_length=120)] = None
    deadline: Annotated[str, StringConstraints(strict=True, max_length=10)] = None
    goal: Text2000 = None
    action: Annotated[str, StringConstraints(strict=True, max_length=6000), AfterValidator(_nonblank)] = None
    verification: Text2000 = None
    targetUrl: Text2000 = None
    notes: Annotated[str, StringConstraints(strict=True, max_length=3000)] = None
    status: TaskStatus = None
    createdAt: Timestamp = None
    updatedAt: Timestamp = None
    baselineCheckId: Identifier | None = None
    baseline: CheckSnapshot | None = None
    evidence: TaskEvidence = None
    postCheck: CheckSnapshot | None = None
    verdict: Verdict | None = None
    comparison: TaskComparison | None = None

    @field_validator("deadline")
    @classmethod
    def valid_deadline(cls, value: str) -> str:
        if value and (len(value) != 10 or date.fromisoformat(value).isoformat() != value):
            raise ValueError("Expected YYYY-MM-DD or an empty string")
        return value

    @field_validator("targetUrl")
    @classmethod
    def valid_target_url(cls, value: str) -> str:
        if value:
            parsed = urlsplit(value)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or any(char.isspace() for char in value):
                raise ValueError("Expected an HTTP or HTTPS URL")
        return value


class TaskCreateInput(TaskFields):
    @model_validator(mode="after")
    def has_brand_reference(self):
        if not any((self.brand, self.brandKey, self.brand_id, self.canonical_id, self.canonicalId)):
            raise ValueError("A brand reference is required")
        return self


class TaskPatchInput(TaskFields):
    pass


def _validate_json(value: Any, depth: int = 1) -> None:
    if isinstance(value, (dict, list)):
        if depth > 8:
            raise ValueError("JSON nesting exceeds eight levels")
        if len(value) > (256 if isinstance(value, dict) else 2048):
            raise ValueError("JSON collection is too large")
        if isinstance(value, dict):
            for key, item in value.items():
                if not isinstance(key, str) or len(key) > 200:
                    raise ValueError("Invalid JSON object key")
                _validate_json(item, depth + 1)
        else:
            for item in value:
                _validate_json(item, depth + 1)
    elif type(value) is float:
        if not math.isfinite(value):
            raise ValueError("JSON numbers must be finite")
    elif value is not None and type(value) not in {str, int, bool}:
        raise ValueError("Expected a JSON value")


def _parse(data: Any, wrapper: str, model: type[StrictInput]) -> dict:
    if not isinstance(data, dict):
        raise ValueError("Expected a JSON object")
    if wrapper in data:
        if len(data) != 1 or not isinstance(data[wrapper], dict):
            raise ValueError("Expected an object in an exclusive wrapper")
        data = data[wrapper]
    _validate_json(data)
    model.model_validate(data)
    return deepcopy(data)


def parse_saved_check(data: Any) -> dict:
    return _parse(data, "check", SavedCheckInput)


def parse_task_create(data: Any) -> dict:
    return _parse(data, "task", TaskCreateInput)


def parse_task_patch(data: Any) -> dict:
    return _parse(data, "task", TaskPatchInput)
