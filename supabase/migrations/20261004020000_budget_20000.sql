alter table managers alter column budget set default 20000;
update managers set budget = 20000 where budget = 200;
