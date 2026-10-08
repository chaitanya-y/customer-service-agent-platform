type MigrationQueryRunner = { query(sql: string): Promise<unknown> };

/** Adds immutable workflow and preview scope to the provider-side marker. */
export class ZeroTotalCancellationScope1760000000001 {
    name = 'ZeroTotalCancellationScope1760000000001';

    async up(queryRunner: MigrationQueryRunner): Promise<void> {
        for (const column of ['workflow_id', 'preview_id', 'preview_expires_at', 'policy_version', 'idempotency_key']) {
            await queryRunner.query(`ALTER TABLE cso_zero_total_cancellation_marker ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        }
    }

    async down(queryRunner: MigrationQueryRunner): Promise<void> {
        for (const column of ['idempotency_key', 'policy_version', 'preview_expires_at', 'preview_id', 'workflow_id']) {
            await queryRunner.query(`ALTER TABLE cso_zero_total_cancellation_marker DROP COLUMN ${column}`);
        }
    }
}
