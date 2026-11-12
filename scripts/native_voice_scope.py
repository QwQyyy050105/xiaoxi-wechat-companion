"""Native voice intake for one owner's already authorized groups."""

# These are distinct bubble classes in the pinned Windows WeChat build. In a
# room with voice intake disabled, do not inspect labels on unclassified rows.
TEXT_AND_IMAGE_ROWS = frozenset((
    'mmui::ChatTextItemView', 'mmui::ChatImageItemView', 'mmui::ChatImageGroupItemView',
))


def voice_target_ids(options, group_ids):
    allowed = frozenset(group_ids)
    if 'voiceTargetIds' not in options:
        return allowed
    selected = options['voiceTargetIds']
    if (not isinstance(selected, list)
            or any(not isinstance(item, str) or item not in allowed for item in selected)
            or len(set(selected)) != len(selected)):
        raise ValueError('native_voice_targets_invalid')
    return frozenset(selected)
