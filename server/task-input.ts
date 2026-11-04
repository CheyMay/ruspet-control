import {z} from 'zod';

export const customFieldsInput=z.array(z.object({
 label:z.string().trim().min(1).max(80),
 value:z.string().trim().max(500)
})).max(12).refine(fields=>new Set(fields.map(field=>field.label.toLocaleLowerCase('ru-RU'))).size===fields.length,'Названия полей должны различаться.');
export type CustomField=z.infer<typeof customFieldsInput>;
export const taskInput=z.object({
 price:z.number().finite().min(0).max(999999999999.99).refine(n=>Math.abs(n*100-Math.round(n*100))<0.001).optional(),
 title:z.string().trim().min(3).max(500),description:z.string().trim().max(10000),assigneeId:z.string().trim().min(1).max(100),
 deadline:z.iso.datetime({offset:true}).nullable(),plannedStart:z.iso.datetime({offset:true}).nullable(),plannedEnd:z.iso.datetime({offset:true}).nullable(),
 important:z.boolean().nullable(),customerRisk:z.boolean().nullable(),parentId:z.string().trim().max(100).nullable(),customFields:customFieldsInput.optional()
});
export type TaskInput=z.infer<typeof taskInput>;
