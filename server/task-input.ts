import {z} from 'zod';

export const customFieldsInput=z.array(z.object({
 label:z.string().trim().min(1).max(80),
 value:z.string().trim().max(500)
})).max(12).refine(fields=>new Set(fields.map(field=>field.label.toLocaleLowerCase('ru-RU'))).size===fields.length,'Названия полей должны различаться.');
export type CustomField=z.infer<typeof customFieldsInput>;
export const taskPriceInput=z.number().finite().min(0).max(999999999999.99).refine(n=>Math.abs(n*100-Math.round(n*100))<0.001);

export const taskInput=z.object({
 price:taskPriceInput.optional(),
 resultRequired:z.boolean().optional(),priority:z.enum(['normal','high']).optional(),critical:z.boolean().optional(),
 groupId:z.uuid().nullable().optional(),
 title:z.string().trim().min(3).max(500),description:z.string().trim().max(10000),assigneeId:z.string().trim().min(1).max(100),
 branchId:z.string().trim().min(1).max(100).optional(),
 deadline:z.iso.datetime({offset:true}).nullable(),plannedStart:z.iso.datetime({offset:true}).nullable(),plannedEnd:z.iso.datetime({offset:true}).nullable(),
 important:z.boolean().nullable(),customerRisk:z.boolean().nullable(),parentId:z.string().trim().max(100).nullable(),customFields:customFieldsInput.optional(),companyId:z.uuid().nullable().optional()
});
export type TaskInput=z.infer<typeof taskInput>;
