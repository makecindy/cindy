"""Frontmatter parsing backed by the vendored PyYAML runtime."""

import math
import re
import sys
from decimal import Decimal
from pathlib import Path

# These helpers execute from Cindy's content-addressed built-in Skill bundle.
# Keep the whole local import chain from mutating that immutable directory.
sys.dont_write_bytecode = True

VENDOR_ROOT = Path(__file__).resolve().parent / "_vendor"
sys.path.insert(0, str(VENDOR_ROOT))

import yaml  # noqa: E402
from yaml.nodes import MappingNode, ScalarNode, SequenceNode  # noqa: E402


class FrontmatterError(ValueError):
    pass


FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)",
    re.DOTALL,
)


class FrontmatterLoader(yaml.SafeLoader):
    """SafeLoader with the scalar resolver semantics used by js-yaml 3."""


# gray-matter 4 uses js-yaml 3's DEFAULT_SAFE_SCHEMA. Unlike PyYAML's YAML 1.1
# resolver, it leaves yes/no/on/off as strings, resolves only true/false as
# booleans, and accepts scientific notation without a decimal point.
# Copy the inherited table before editing so other vendored PyYAML consumers
# retain SafeLoader's defaults.
FrontmatterLoader.yaml_implicit_resolvers = {
    first: [
        (tag, resolver)
        for tag, resolver in resolvers
        if tag not in {"tag:yaml.org,2002:bool", "tag:yaml.org,2002:float"}
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
FrontmatterLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
    list("tTfF"),
)
FrontmatterLoader.add_implicit_resolver(
    "tag:yaml.org,2002:float",
    re.compile(
        r"""^(?:
            [-+]?(?:0|[1-9][0-9_]*)(?:
                \.[0-9_]*(?:[eE][-+]?[0-9]+)?
                |[eE][-+]?[0-9]+
            )
            |\.[0-9_]+(?:[eE][-+]?[0-9]+)?
            |[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*
            |[-+]?\.(?:inf|Inf|INF)
            |\.(?:nan|NaN|NAN)
        )$""",
        re.X,
    ),
    list("-+0123456789."),
)


def split_frontmatter(content):
    match = FRONTMATTER_RE.match(content)
    if not match:
        raise FrontmatterError("Invalid frontmatter format")
    return match.group(1), match.end()


def _js_number_key(value):
    """Return JavaScript's property-key spelling for a YAML number."""
    try:
        number = float(value)
    except OverflowError:
        return "-Infinity" if value < 0 else "Infinity"
    if math.isnan(number):
        return "NaN"
    if math.isinf(number):
        return "-Infinity" if number < 0 else "Infinity"
    if number == 0:
        return "0"
    magnitude = abs(number)
    if 1e-6 <= magnitude < 1e21:
        return format(Decimal(repr(number)), "f")
    return re.sub(r"e([+-])0+(\d+)$", r"e\1\2", repr(number).lower())


def _js_scalar_key(value):
    """Mirror js-yaml 3's String(keyNode) mapping-key identity."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_number_key(value)
    return str(value)


def _reject_duplicate_mapping_keys(loader, node, visited=None):
    """Match js-yaml's duplicate check using each scalar's constructed value."""
    if visited is None:
        visited = set()
    identity = id(node)
    if identity in visited:
        return
    visited.add(identity)

    if isinstance(node, MappingNode):
        keys = set()
        for key_node, value_node in node.value:
            if isinstance(key_node, ScalarNode):
                # js-yaml constructs timestamp keys as Date objects and then relies on
                # JavaScript property-key coercion. Date#toString is host-timezone
                # dependent, so reproducing that identity in the bundled Python
                # validator would accept different documents on different machines.
                # Timestamp metadata keys are not part of the Skill contract; reject
                # them consistently instead of letting a duplicate through to the
                # gray-matter/js-yaml runtime.
                if key_node.tag == "tag:yaml.org,2002:timestamp":
                    raise FrontmatterError(
                        f"Timestamp mapping keys are not supported on line {key_node.start_mark.line + 1}"
                    )
                key = _js_scalar_key(loader.construct_object(key_node, deep=True))
                if key in keys:
                    raise FrontmatterError(
                        f"Duplicate mapping key '{key_node.value}' on line {key_node.start_mark.line + 1}"
                    )
                keys.add(key)
            _reject_duplicate_mapping_keys(loader, key_node, visited)
            _reject_duplicate_mapping_keys(loader, value_node, visited)
    elif isinstance(node, SequenceNode):
        for value_node in node.value:
            _reject_duplicate_mapping_keys(loader, value_node, visited)


def parse_frontmatter(frontmatter_text):
    loader = None
    try:
        loader = FrontmatterLoader(frontmatter_text)
        root = loader.get_single_node()
        if root is not None:
            _reject_duplicate_mapping_keys(loader, root)
            return loader.construct_document(root)
        return None
    except FrontmatterError:
        raise
    except yaml.YAMLError as exc:
        raise FrontmatterError(str(exc)) from exc
    finally:
        if loader is not None:
            loader.dispose()
