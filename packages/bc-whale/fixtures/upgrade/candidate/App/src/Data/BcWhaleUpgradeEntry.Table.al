namespace BcWhale.Validation.Data;

/// <summary>Stores persistent synthetic upgrade evidence.</summary>
/// <remarks>Public solely as the separate test app's synthetic data contract; no business data.</remarks>
table 50200 BcWhaleUpgradeEntry
{
    Access = Public;
    Extensible = false;
    DataClassification = CustomerContent;
    Caption = 'Upgrade validation entry';

    fields
    {
        field(1; EntryNo; Integer)
        {
            Caption = 'Entry number';
            ToolTip = 'Specifies the synthetic row identifier.';
        }
        field(2; OriginalValue; Integer)
        {
            Caption = 'Original value';
            ToolTip = 'Specifies the value that must survive the upgrade.';
        }
        field(3; MigratedValue; Integer)
        {
            Caption = 'Migrated value';
            ToolTip = 'Specifies the value written by the upgrade.';
        }
        field(4; UpgradeApplied; Boolean)
        {
            Caption = 'Upgrade applied';
            ToolTip = 'Specifies whether the candidate upgrade processed this row.';
        }
    }

    keys
    {
        key(PK; EntryNo)
        {
            Clustered = true;
        }
    }
}
