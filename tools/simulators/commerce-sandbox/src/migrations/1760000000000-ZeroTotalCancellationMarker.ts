type MigrationQueryRunner = { query(sql: string): Promise<unknown> };

/** Local SQLite operation marker committed with Vendure's order cancellation. */
export class ZeroTotalCancellationMarker1760000000000 {
    name = 'ZeroTotalCancellationMarker1760000000000';

    async up(queryRunner: MigrationQueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE cso_zero_total_cancellation_marker (
            operation_id TEXT PRIMARY KEY NOT NULL,
            order_id TEXT NOT NULL UNIQUE,
            tenant_id TEXT NOT NULL,
            environment_id TEXT NOT NULL,
            customer_id TEXT NOT NULL,
            order_reference TEXT NOT NULL,
            facts_digest TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED')),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
    }

    async down(queryRunner: MigrationQueryRunner): Promise<void> {
        await queryRunner.query('DROP TABLE cso_zero_total_cancellation_marker');
    }
}
